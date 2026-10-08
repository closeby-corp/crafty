import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import prometheusCommand from '../commands/prometheus.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { envelope, runCaptured } from './helpers/cli.ts'
import { startMockServer, type RecordedRequest } from './helpers/mock-server.ts'

const dir = mkdtempSync(join(tmpdir(), 'ops-prom-'))
let counter = 0

function writeConfig(baseUrl: string, maxRows = 200): void {
  counter += 1
  const path = join(dir, `config-${counter}.yml`)
  writeFileSync(
    path,
    [
      'settings:',
      `  max_rows: ${maxRows}`,
      `  data_dir: "${dir}"`,
      'targets:',
      '  mock:',
      '    kind: prometheus',
      `    base_url: "${baseUrl}"`,
      '    auth: none',
      '',
    ].join('\n'),
  )
  process.env['OPS_CONFIG'] = path
  resetConfigCache()
}

/** The query string a request carried, split into parameters. */
function queryOf(recorded: RecordedRequest): URLSearchParams {
  return new URLSearchParams(recorded.query)
}

beforeEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

afterEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const VECTOR = {
  status: 'success',
  data: {
    resultType: 'vector',
    result: [
      { metric: { __name__: 'up', job: 'prometheus' }, value: [1700000000, '1'] },
      { metric: { __name__: 'up', job: 'node' }, value: [1700000000, '1'] },
    ],
  },
}

const MATRIX = {
  status: 'success',
  data: {
    resultType: 'matrix',
    result: [{ metric: { __name__: 'up' }, values: [[1700000000, '1'], [1700000060, '0']] }],
  },
}

describe('prometheus query', () => {
  test('unwraps data.result into rows and records the expression', async () => {
    const mock = startMockServer([{ path: '/api/v1/query', body: VECTOR }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['query', 'up', '--json'])
    expect(capture.code).toBe(0)
    const body = envelope(capture)
    expect(body['ok']).toBe(true)
    expect(body['source']).toBe('prometheus')
    expect(body['target']).toBe('mock')
    expect(body['data']).toEqual(VECTOR.data.result)
    expect((body['meta'] as Record<string, unknown>)['count']).toBe(2)
    expect((body['meta'] as Record<string, unknown>)['result_type']).toBe('vector')

    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]!.path).toBe('/api/v1/query')
    expect(queryOf(mock.requests[0]!).get('query')).toBe('up')
  })

  test('--at becomes an epoch-second time parameter', async () => {
    const mock = startMockServer([{ path: '/api/v1/query', body: VECTOR }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['query', 'up', '--at', '1700000000', '--json'])
    expect(capture.code).toBe(0)
    expect(queryOf(mock.requests[0]!).get('time')).toBe('1700000000')
  })

  test('a missing expression is a usage error before any request', async () => {
    const mock = startMockServer([{ path: '/api/v1/query', body: VECTOR }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['query', '--json'])
    expect(capture.code).toBe(2)
    expect((envelope(capture)['error'] as Record<string, unknown>)['kind']).toBe('usage')
    expect(mock.requests).toHaveLength(0)
  })
})

describe('prometheus range', () => {
  test('builds start, end and step and unwraps the matrix', async () => {
    const mock = startMockServer([{ path: '/api/v1/query_range', body: MATRIX }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, [
      'range',
      'up',
      '--start',
      '1700000000',
      '--end',
      '1700003600',
      '--step',
      '60s',
      '--json',
    ])
    expect(capture.code).toBe(0)
    const params = queryOf(mock.requests[0]!)
    expect(mock.requests[0]!.path).toBe('/api/v1/query_range')
    expect(params.get('query')).toBe('up')
    expect(params.get('start')).toBe('1700000000')
    expect(params.get('end')).toBe('1700003600')
    expect(params.get('step')).toBe('60s')

    const body = envelope(capture)
    expect(body['data']).toEqual(MATRIX.data.result)
    expect((body['meta'] as Record<string, unknown>)['result_type']).toBe('matrix')
  })

  test('picks a step from a default one-hour window', async () => {
    const mock = startMockServer([{ path: '/api/v1/query_range', body: MATRIX }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['range', 'up', '--since', '1h', '--json'])
    expect(capture.code).toBe(0)
    const params = queryOf(mock.requests[0]!)
    // 3600s over at most 1000 points -> the smallest offered step of 5s.
    expect(params.get('step')).toBe('5')
    expect(Number(params.get('end')) - Number(params.get('start'))).toBeCloseTo(3600, -1)
  })

  test('--since and --start together are rejected without a request', async () => {
    const mock = startMockServer([{ path: '/api/v1/query_range', body: MATRIX }])
    writeConfig(mock.url)

    const argv = ['range', 'up', '--since', '1h', '--start', '1700000000', '--json']
    const capture = await runCaptured(prometheusCommand, argv)
    expect(capture.code).toBe(2)
    expect((envelope(capture)['error'] as Record<string, unknown>)['kind']).toBe('usage')
    expect(mock.requests).toHaveLength(0)
  })
})

describe('prometheus label listings', () => {
  test('labels wraps each name in a row', async () => {
    const mock = startMockServer([{ path: '/api/v1/labels', body: { status: 'success', data: ['__name__', 'job'] } }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['labels', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([{ label: '__name__' }, { label: 'job' }])
    expect(mock.requests[0]!.path).toBe('/api/v1/labels')
  })

  test('label <name> reads the values endpoint', async () => {
    const route = { path: '/api/v1/label/job/values', body: { status: 'success', data: ['prometheus'] } }
    const mock = startMockServer([route])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['label', 'job', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([{ value: 'prometheus' }])
    expect(mock.requests[0]!.path).toBe('/api/v1/label/job/values')
  })

  test('series sends the selector as match[]', async () => {
    const body = { status: 'success', data: [{ __name__: 'up', job: 'prometheus' }] }
    const mock = startMockServer([{ path: '/api/v1/series', body }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['series', '--match', 'up{job="prometheus"}', '--json'])
    expect(capture.code).toBe(0)
    expect(queryOf(mock.requests[0]!).get('match[]')).toBe('up{job="prometheus"}')
    expect(envelope(capture)['data']).toEqual([{ __name__: 'up', job: 'prometheus' }])
  })

  test('series without --match is a usage error', async () => {
    const mock = startMockServer([{ path: '/api/v1/series', body: { status: 'success', data: [] } }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['series', '--json'])
    expect(capture.code).toBe(2)
    expect(mock.requests).toHaveLength(0)
  })
})

describe('prometheus server introspection', () => {
  test('targets and rules pass the data object through', async () => {
    const mock = startMockServer([
      {
        path: '/api/v1/targets',
        body: { status: 'success', data: { activeTargets: [{ scrapeUrl: 'http://a' }], droppedTargets: [] } },
      },
      { path: '/api/v1/rules', body: { status: 'success', data: { groups: [{ name: 'g' }] } } },
    ])
    writeConfig(mock.url)

    const targets = envelope(await runCaptured(prometheusCommand, ['targets', '--json']))
    expect(targets['data']).toEqual({ activeTargets: [{ scrapeUrl: 'http://a' }], droppedTargets: [] })

    const rules = envelope(await runCaptured(prometheusCommand, ['rules', '--json']))
    expect(rules['data']).toEqual({ groups: [{ name: 'g' }] })
  })

  test('alerts unwraps the alert array', async () => {
    const body = { status: 'success', data: [{ labels: { alertname: 'Down' }, state: 'firing' }] }
    const mock = startMockServer([{ path: '/api/v1/alerts', body }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['alerts', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([{ labels: { alertname: 'Down' }, state: 'firing' }])
  })

  test('build unwraps the build info object', async () => {
    const body = { status: 'success', data: { version: '2.53.0', revision: 'abc' } }
    const mock = startMockServer([{ path: '/api/v1/status/buildinfo', body }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['build', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual({ version: '2.53.0', revision: 'abc' })
  })
})

describe('prometheus error mapping', () => {
  test('a non-success body is an upstream error carrying errorType', async () => {
    const body = { status: 'error', errorType: 'bad_data', error: 'invalid parameter "query"' }
    const mock = startMockServer([{ path: '/api/v1/query', body }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['query', 'up', '--json'])
    expect(capture.code).toBe(1)
    const envelopeBody = envelope(capture)
    expect(envelopeBody['ok']).toBe(false)
    const error = envelopeBody['error'] as Record<string, unknown>
    expect(error['kind']).toBe('upstream')
    expect(error['message']).toContain('bad_data')
    expect(error['message']).toContain('invalid parameter')
  })

  test('a 401 maps to the auth kind and exit code 3', async () => {
    const mock = startMockServer([
      {
        path: '/api/v1/query',
        status: 401,
        body: { status: 'error', errorType: 'unauthorized', error: 'unauthorized' },
      },
    ])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['query', 'up', '--json'])
    expect(capture.code).toBe(3)
    const body = envelope(capture)
    expect(body['ok']).toBe(false)
    expect((body['error'] as Record<string, unknown>)['kind']).toBe('auth')
  })

  test('a 404 maps to not-found', async () => {
    const mock = startMockServer([{ path: '/api/v1/status/buildinfo', status: 404, body: { message: 'not found' } }])
    writeConfig(mock.url)

    const capture = await runCaptured(prometheusCommand, ['build', '--json'])
    expect(capture.code).toBe(1)
    expect((envelope(capture)['error'] as Record<string, unknown>)['kind']).toBe('not-found')
  })
})

describe('prometheus row cap', () => {
  test('caps a row set at settings.max_rows and flags truncation', async () => {
    const body = { status: 'success', data: [{ a: '1' }, { b: '2' }, { c: '3' }] }
    const mock = startMockServer([{ path: '/api/v1/series', body }])
    writeConfig(mock.url, 1)

    const capture = await runCaptured(prometheusCommand, ['series', '--match', 'up', '--json'])
    expect(capture.code).toBe(0)
    const envelopeBody = envelope(capture)
    expect(envelopeBody['data']).toEqual([{ a: '1' }])
    const meta = envelopeBody['meta'] as Record<string, unknown>
    expect(meta['count']).toBe(1)
    expect(meta['truncated']).toBe(true)
  })
})
