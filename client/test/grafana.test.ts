import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import grafanaCommand from '../commands/grafana.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { startMockServer } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-grafana-'))
let counter = 0

/** A config with one grafana target, pointed at the running mock server. */
function configFor(url: string, extra = ''): string {
  counter += 1
  const path = join(scratch, `config-${counter}.yml`)
  writeFileSync(
    path,
    [
      'settings:',
      '  timeout_ms: 2000',
      '  max_rows: 3',
      `  data_dir: "${scratch}"`,
      'targets:',
      '  mock:',
      '    kind: grafana',
      `    base_url: "${url}"`,
      '    auth: none',
      extra,
      '',
    ].join('\n'),
  )
  return path
}

beforeEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

afterEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function runWith(configPath: string, argv: string[]): Promise<CliCapture> {
  process.env['OPS_CONFIG'] = configPath
  resetConfigCache()
  return await runCaptured(grafanaCommand, argv)
}

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

const DASHBOARDS = [
  { uid: 'a', title: 'Cluster', url: '/d/a', folderTitle: 'Infra', tags: ['prod', 'k8s'] },
  { uid: 'b', title: 'Billing', url: '/d/b', folderTitle: 'BI', tags: [] },
]

describe('ops grafana health', () => {
  test('prints the /api/health body and names the target', async () => {
    const server = startMockServer([{ path: '/api/health', body: { database: 'ok', version: '11.2.0' } }])
    const capture = await runWith(configFor(server.url), ['health', '--json'])

    expect(capture.code).toBe(0)
    const env = envelope(capture)
    expect(env['source']).toBe('grafana')
    expect(env['target']).toBe('mock')
    expect(env['data']).toEqual({ database: 'ok', version: '11.2.0' })

    const request = server.of('GET')[0]!
    expect(request.path).toBe('/api/health')
    expect(request.query).toBe('')
  })

  test('maps a 401 to an auth failure with exit code 3', async () => {
    const server = startMockServer([{ path: '/api/health', status: 401, body: { message: 'Unauthorized' } }])
    const capture = await runWith(configFor(server.url), ['health', '--json'])

    expect(capture.code).toBe(3)
    const error = errorOf(capture)
    expect(error['kind']).toBe('auth')
    expect(error['status']).toBe(401)
  })
})

describe('ops grafana datasources', () => {
  test('renders flat rows and truncates at settings.max_rows', async () => {
    const list = Array.from({ length: 5 }, (_, index) => ({
      uid: `uid-${index}`,
      name: `ds-${index}`,
      type: 'prometheus',
      url: `http://prom-${index}`,
      isDefault: index === 0,
    }))
    const server = startMockServer([{ path: '/api/datasources', body: list }])
    const capture = await runWith(configFor(server.url), ['datasources', '--json'])

    expect(capture.code).toBe(0)
    const env = envelope(capture)
    const rows = env['data'] as Record<string, unknown>[]
    expect(rows.length).toBe(3)
    expect((env['meta'] as Record<string, unknown>)['truncated']).toBe(true)
    expect(rows[0]).toEqual({ uid: 'uid-0', name: 'ds-0', type: 'prometheus', url: 'http://prom-0', is_default: true })
    expect(rows[1]!['is_default']).toBe(false)
  })
})

describe('ops grafana dashboards', () => {
  test('sends type=dash-db and the query, and flattens the rows', async () => {
    const server = startMockServer([{ path: '/api/search', body: DASHBOARDS }])
    const capture = await runWith(configFor(server.url), ['dashboards', '--query', 'prod', '--json'])

    expect(capture.code).toBe(0)
    const request = server.of('GET')[0]!
    expect(request.path).toBe('/api/search')
    const params = new URLSearchParams(request.query)
    expect(params.get('type')).toBe('dash-db')
    expect(params.get('query')).toBe('prod')

    const rows = envelope(capture)['data'] as Record<string, unknown>[]
    expect(rows[0]).toEqual({ uid: 'a', title: 'Cluster', url: '/d/a', folder: 'Infra', tags: 'prod,k8s' })
    expect(rows[1]).toEqual({ uid: 'b', title: 'Billing', url: '/d/b', folder: 'BI', tags: '' })
  })

  test('omits the query parameter when --query is absent', async () => {
    const server = startMockServer([{ path: '/api/search', body: [] }])
    await runWith(configFor(server.url), ['dashboards', '--json'])
    const params = new URLSearchParams(server.of('GET')[0]!.query)
    expect(params.has('query')).toBe(false)
    expect(params.get('type')).toBe('dash-db')
  })
})

describe('ops grafana dashboard', () => {
  test('fetches one dashboard by uid', async () => {
    const document = { dashboard: { uid: 'abc', title: 'One' }, meta: { version: 3 } }
    const server = startMockServer([{ path: '/api/dashboards/uid/abc', body: document }])
    const capture = await runWith(configFor(server.url), ['dashboard', 'abc', '--json'])

    expect(capture.code).toBe(0)
    expect(server.of('GET')[0]!.path).toBe('/api/dashboards/uid/abc')
    expect(envelope(capture)['data']).toEqual(document)
  })

  test('maps a 404 to not-found and exit code 1', async () => {
    const server = startMockServer([])
    const capture = await runWith(configFor(server.url), ['dashboard', 'missing', '--json'])

    expect(capture.code).toBe(1)
    const error = errorOf(capture)
    expect(error['kind']).toBe('not-found')
    expect(error['status']).toBe(404)
  })

  test('requires a uid', async () => {
    const server = startMockServer([])
    const capture = await runWith(configFor(server.url), ['dashboard', '--json'])
    expect(capture.code).toBe(2)
    expect(server.requests.length).toBe(0)
  })
})

describe('ops grafana annotations', () => {
  test('sends the window as epoch milliseconds', async () => {
    const server = startMockServer([
      { path: '/api/annotations', body: [{ id: 1, time: 1000, timeEnd: 2000, text: 'deploy', tags: ['ci'] }] },
    ])
    const capture = await runWith(configFor(server.url), [
      'annotations',
      '--from',
      '2026-01-01T00:00:00Z',
      '--to',
      '2026-01-02T00:00:00Z',
      '--json',
    ])

    expect(capture.code).toBe(0)
    const params = new URLSearchParams(server.of('GET')[0]!.query)
    expect(Number(params.get('from'))).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(Number(params.get('to'))).toBe(Date.parse('2026-01-02T00:00:00Z'))

    const rows = envelope(capture)['data'] as Record<string, unknown>[]
    expect(rows[0]).toEqual({ id: 1, time: 1000, time_end: 2000, text: 'deploy', tags: 'ci' })
  })

  test('rejects an unreadable --from before any request', async () => {
    const server = startMockServer([])
    const capture = await runWith(configFor(server.url), ['annotations', '--from', 'yesterday', '--json'])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests.length).toBe(0)
  })
})

const QUERY_FRAMES = {
  results: {
    A: {
      status: 200,
      frames: [
        {
          schema: {
            name: 'up',
            fields: [
              { name: 'Time', type: 'time' },
              { name: 'Value', type: 'number', labels: { instance: 'host:9100' } },
            ],
          },
          data: { values: [[1000, 2000, 3000], [1, 2, 3]] },
        },
      ],
    },
  },
}

const DATASOURCES = [{ uid: 'uid-prom', name: 'Prom', type: 'prometheus' }]

describe('ops grafana query', () => {
  test('resolves a datasource by name, posts the exact body and flattens the frames', async () => {
    const server = startMockServer([
      { path: '/api/datasources', body: DATASOURCES },
      { path: '/api/ds/query', body: QUERY_FRAMES },
    ])
    const capture = await runWith(configFor(server.url), [
      'query',
      '--datasource',
      'Prom',
      '--expr',
      'up',
      '--since',
      '1h',
      '--step',
      '30s',
      '--json',
    ])

    expect(capture.code).toBe(0)

    // The name is resolved through the list endpoint before the query is sent.
    const list = server.of('GET')[0]!
    expect(list.path).toBe('/api/datasources')

    const post = server.of('POST')[0]!
    expect(post.path).toBe('/api/ds/query')
    const body = JSON.parse(post.body) as Record<string, unknown>
    expect(body['to']).toBe('now')
    expect(typeof body['from']).toBe('string')
    expect(body['from'] as string).toMatch(/^now-\d+s$/)
    const query = (body['queries'] as Record<string, unknown>[])[0]!
    expect(query).toEqual({
      refId: 'A',
      datasource: { uid: 'uid-prom' },
      expr: 'up',
      instant: false,
      range: true,
      intervalMs: 30_000,
      maxDataPoints: 120,
    })

    const data = envelope(capture)['data'] as Record<string, unknown>
    expect(data['series']).toEqual([
      { metric: 'Value{instance="host:9100"}', points: [[1000, 1], [2000, 2], [3000, 3]] },
    ])
  })

  test('accepts a uid as --datasource and sets instant', async () => {
    const server = startMockServer([
      { path: '/api/datasources', body: DATASOURCES },
      { path: '/api/ds/query', body: QUERY_FRAMES },
    ])
    const capture = await runWith(configFor(server.url), [
      'query',
      '--datasource',
      'uid-prom',
      '--expr',
      'up',
      '--instant',
      '--json',
    ])

    expect(capture.code).toBe(0)
    const sent = JSON.parse(server.of('POST')[0]!.body) as Record<string, unknown>
    const query = (sent['queries'] as Record<string, unknown>[])[0]!
    expect((query['datasource'] as Record<string, unknown>)['uid']).toBe('uid-prom')
    expect(query['instant']).toBe(true)
    expect(query['intervalMs']).toBe(60_000)
  })

  test('fails not-found when the datasource is unknown, without posting', async () => {
    const server = startMockServer([{ path: '/api/datasources', body: DATASOURCES }])
    const capture = await runWith(configFor(server.url), ['query', '--datasource', 'nope', '--expr', 'up', '--json'])

    expect(capture.code).toBe(1)
    const error = errorOf(capture)
    expect(error['kind']).toBe('not-found')
    expect(server.of('POST').length).toBe(0)
  })

  test('requires --datasource and --expr', async () => {
    const server = startMockServer([])
    const capture = await runWith(configFor(server.url), ['query', '--expr', 'up', '--json'])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests.length).toBe(0)
  })

  test('caps the series at settings.max_rows', async () => {
    const frames = {
      results: {
        A: {
          frames: [
            {
              schema: {
                fields: [
                  { name: 'Time', type: 'time' },
                  ...Array.from({ length: 5 }, (_, index) => ({ name: `v${index}`, type: 'number' })),
                ],
              },
              data: { values: [[1], [1], [2], [3], [4], [5]] },
            },
          ],
        },
      },
    }
    const server = startMockServer([
      { path: '/api/datasources', body: DATASOURCES },
      { path: '/api/ds/query', body: frames },
    ])
    const capture = await runWith(configFor(server.url), ['query', '--datasource', 'Prom', '--expr', 'up', '--json'])

    const env = envelope(capture)
    expect((env['data'] as Record<string, unknown>)['series']).toHaveLength(3)
    expect((env['meta'] as Record<string, unknown>)['truncated']).toBe(true)
  })
})

describe('target selection', () => {
  test('--target picks between two grafana targets', async () => {
    const server = startMockServer([{ path: '/other/api/health', body: { database: 'ok' } }])
    const extra = `  other:\n    kind: grafana\n    base_url: "${server.url}/other"\n    auth: none\n`
    const capture = await runWith(configFor(server.url, extra), ['health', '--target', 'other', '--json'])

    expect(capture.code).toBe(0)
    expect(server.of('GET')[0]!.path).toBe('/other/api/health')
    expect(envelope(capture)['target']).toBe('other')
  })
})
