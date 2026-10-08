import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import opensearchCommand from '../commands/opensearch.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { startMockServer, type MockRoute, type MockServer } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-os-'))
const configPath = join(scratch, 'config.yml')

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  resetConfigCache()
})

/** A fresh mock server plus a config that points the `mock` target at it. */
function configure(routes: MockRoute[], maxRows = 200): MockServer {
  const server = startMockServer(routes)
  writeFileSync(
    configPath,
    [
      'settings:',
      `  max_rows: ${maxRows}`,
      'targets:',
      '  mock:',
      '    kind: opensearch',
      `    base_url: "${server.url}"`,
      '    auth: none',
      '    time_field: "@timestamp"',
      '    default_index: "logs-*"',
      '',
    ].join('\n'),
  )
  process.env['OPS_CONFIG'] = configPath
  resetConfigCache()
  return server
}

// The config file is process-wide, so leaving OPS_CONFIG behind would point
// every later test file at a deleted temp path.
afterEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

function queryOf(server: MockServer, index: number): URLSearchParams {
  return new URLSearchParams(server.requests[index]!.query)
}

function bodyOf(server: MockServer, index: number): Record<string, unknown> {
  return JSON.parse(server.requests[index]!.body) as Record<string, unknown>
}

const HIT = {
  _index: 'logs-app',
  _id: 'hit-1',
  _source: { '@timestamp': '2026-10-07T10:00:00.000Z', message: 'hello', service: 'api', other: 'x' },
}

describe('ops os health', () => {
  test('reads the cluster health document', async () => {
    const server = configure([{ path: '/_cluster/health', body: { status: 'green', number_of_nodes: 3 } }])
    const capture = await runCaptured(opensearchCommand, ['health', '--json'])
    expect(capture.code).toBe(0)
    expect(server.of('GET')).toHaveLength(1)
    expect(server.requests[0]!.path).toBe('/_cluster/health')
    expect(envelope(capture)['data']).toEqual({ status: 'green', number_of_nodes: 3 })
  })

  test('maps 401 to an auth failure with exit 3', async () => {
    const server = configure([
      { path: '/_cluster/health', status: 401, body: { error: { reason: 'Unauthorized' } } },
    ])
    const capture = await runCaptured(opensearchCommand, ['health', '--json'])
    expect(capture.code).toBe(3)
    expect(envelope(capture)['ok']).toBe(false)
    expect(errorOf(capture)['kind']).toBe('auth')
    expect(errorOf(capture)['status']).toBe(401)
    expect(server.requests).toHaveLength(1)
  })
})

describe('ops os indices', () => {
  const CAT = [
    { index: 'logs-app-0001', health: 'green', status: 'open', 'docs.count': '12', 'store.size': '1mb' },
    { index: 'logs-app-0002', health: 'yellow', status: 'open', 'docs.count': '3', 'store.size': '2kb' },
    { index: 'metrics-0001', health: 'green', status: 'open', 'docs.count': '40', 'store.size': '9mb' },
  ]

  test('asks _cat for the five columns and renders one row per index', async () => {
    const server = configure([{ path: '/_cat/indices', body: CAT }])
    const capture = await runCaptured(opensearchCommand, ['indices', '--json'])
    expect(capture.code).toBe(0)
    const query = queryOf(server, 0)
    expect(query.get('format')).toBe('json')
    expect(query.get('h')).toBe('index,health,status,docs.count,store.size')
    expect(query.get('expand_wildcards')).toBeNull()
    expect(envelope(capture)['data']).toEqual(CAT)
    expect(envelope(capture)['meta']).toMatchObject({ count: 3, truncated: false })
  })

  test('filters locally by pattern', async () => {
    configure([{ path: '/_cat/indices', body: CAT }])
    const capture = await runCaptured(opensearchCommand, ['indices', '--pattern', 'logs-*', '--json'])
    expect(capture.code).toBe(0)
    const data = envelope(capture)['data'] as Array<Record<string, unknown>>
    expect(data.map((row) => row['index'])).toEqual(['logs-app-0001', 'logs-app-0002'])
  })

  test('--all widens expand_wildcards', async () => {
    const server = configure([{ path: '/_cat/indices', body: CAT }])
    await runCaptured(opensearchCommand, ['indices', '--all', '--json'])
    expect(queryOf(server, 0).get('expand_wildcards')).toBe('all')
  })

  test('caps the rows at settings.max_rows and flags truncation', async () => {
    configure([{ path: '/_cat/indices', body: CAT }], 2)
    const capture = await runCaptured(opensearchCommand, ['indices', '--json'])
    const data = envelope(capture)['data'] as unknown[]
    expect(data).toHaveLength(2)
    expect(envelope(capture)['meta']).toMatchObject({ count: 2, truncated: true })
  })
})

describe('ops os mapping', () => {
  test('reads one index mapping', async () => {
    const body = { 'logs-app': { mappings: { properties: { message: { type: 'text' } } } } }
    const server = configure([{ path: '/logs-app/_mapping', body }])
    const capture = await runCaptured(opensearchCommand, ['mapping', 'logs-app', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.path).toBe('/logs-app/_mapping')
    expect(envelope(capture)['data']).toEqual(body)
  })

  test('refuses without an index, contacting nothing', async () => {
    const server = configure([])
    const capture = await runCaptured(opensearchCommand, ['mapping', '--json'])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests).toHaveLength(0)
  })

  test('maps 404 to not-found', async () => {
    configure([{ path: '/logs-nope/_mapping', status: 404, body: { error: { reason: 'no such index' } } }])
    const capture = await runCaptured(opensearchCommand, ['mapping', 'logs-nope', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('not-found')
  })
})

describe('ops os count', () => {
  test('posts the query string to _count', async () => {
    const server = configure([{ path: '/logs-app/_count', body: { count: 42 } }])
    const capture = await runCaptured(
      opensearchCommand,
      ['count', '--index', 'logs-app', '--query', 'level:error', '--json'],
    )
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.method).toBe('POST')
    expect(bodyOf(server, 0)).toEqual({
      query: { query_string: { query: 'level:error', analyze_wildcard: true } },
    })
    expect(envelope(capture)['data']).toEqual({ count: 42 })
  })

  test('sends an empty body when no query is given', async () => {
    const server = configure([{ path: '/logs-*/_count', body: { count: 7 } }])
    const capture = await runCaptured(opensearchCommand, ['count', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.path).toBe('/logs-*/_count')
    expect(bodyOf(server, 0)).toEqual({})
  })
})

describe('ops os query', () => {
  test('assembles the body from query, since, fields, size and sort', async () => {
    const server = configure([{ path: '/logs-app/_search', body: { hits: { hits: [HIT] } } }])
    const before = Date.now()
    const capture = await runCaptured(opensearchCommand, [
      'query',
      '--index',
      'logs-app',
      '--query',
      'level:error',
      '--since',
      '1h',
      '--fields',
      'message,service',
      '--size',
      '2',
      '--sort',
      'asc',
      '--json',
    ])
    expect(capture.code).toBe(0)
    const body = bodyOf(server, 0)
    const bool = (body['query'] as Record<string, unknown>)['bool'] as Record<string, unknown>
    expect(bool['must']).toEqual([{ query_string: { query: 'level:error', analyze_wildcard: true } }])
    const filters = bool['filter'] as Array<Record<string, unknown>>
    const bounds = (filters[0]!['range'] as Record<string, Record<string, string>>)['@timestamp']!
    expect(Date.parse(bounds['gte']!)).toBeLessThanOrEqual(before)
    expect(Date.parse(bounds['gte']!)).toBeGreaterThanOrEqual(before - 3_600_000)
    expect(body['size']).toBe(2)
    expect(body['sort']).toEqual([{ '@timestamp': { order: 'asc' } }])
    expect(body['_source']).toEqual(['message', 'service'])

    // The catalog decides the field: EKS says `level`, and the override exists
    // because one cluster can hold families that disagree on the field name.
    await runCaptured(opensearchCommand, ['query', '--index', 'idx-*', '--level', 'ERROR', '--json'])
    const levelMust = (bodyOf(server, 1)['query'] as Record<string, any>)['bool']['must']
    expect(levelMust).toEqual([{ match: { level: 'ERROR' } }])
    await runCaptured(opensearchCommand, [
      'query',
      '--index',
      'logstash-production-logback-*',
      '--level',
      'ERROR',
      '--level-field',
      'log_level',
      '--json',
    ])
    expect((bodyOf(server, 2)['query'] as Record<string, any>)['bool']['must']).toEqual([
      { match: { log_level: 'ERROR' } },
    ])

    expect(envelope(capture)['data']).toEqual([
      {
        _index: 'logs-app',
        _id: 'hit-1',
        ts: '2026-10-07T10:00:00.000Z',
        message: 'hello',
        service: 'api',
        _source: HIT._source,
      },
    ])
  })

  test('--dsl replaces the body but keeps defaulted size and sort', async () => {
    const server = configure([{ path: '/logs-*/_search', body: { hits: { hits: [] } } }])
    const capture = await runCaptured(opensearchCommand, [
      'query',
      '--dsl',
      '{"query":{"match_all":{}}}',
      '--json',
    ])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.path).toBe('/logs-*/_search')
    expect(queryOf(server, 0).get('scroll')).toBeNull()
    expect(bodyOf(server, 0)).toEqual({
      query: { match_all: {} },
      size: 50,
      sort: [{ '@timestamp': { order: 'desc' } }],
    })
  })

  test('--dsl keeps a size and sort it was given', async () => {
    const server = configure([{ path: '/logs-app/_search', body: { hits: { hits: [] } } }])
    await runCaptured(opensearchCommand, [
      'query',
      '--index',
      'logs-app',
      '--dsl',
      '{"size":7,"sort":[{"level":{"order":"asc"}}]}',
      '--json',
    ])
    expect(bodyOf(server, 0)).toEqual({ size: 7, sort: [{ level: { order: 'asc' } }] })
  })

  test('--all walks the scroll API and releases the cursor', async () => {
    const second = { _index: 'logs-app', _id: 'hit-2', _source: { '@timestamp': '2026-10-07T09:00:00.000Z' } }
    const server = configure([
      { path: '/logs-app/_search', body: { _scroll_id: 's1', hits: { hits: [HIT] } } },
      {
        path: '/_search/scroll',
        handler: (request, seen) => {
          if (request.method === 'DELETE') return { body: {} }
          return seen === 0
            ? { body: { _scroll_id: 's2', hits: { hits: [second] } } }
            : { body: { _scroll_id: 's2', hits: { hits: [] } } }
        },
      },
    ])
    const capture = await runCaptured(opensearchCommand, ['query', '--index', 'logs-app', '--all', '--json'])
    expect(capture.code).toBe(0)
    expect(queryOf(server, 0).get('scroll')).toBe('1m')
    expect(server.requests[0]!.path).toBe('/logs-app/_search')
    expect(server.requests[1]!.method).toBe('POST')
    expect(bodyOf(server, 1)).toEqual({ scroll: '1m', scroll_id: 's1' })
    expect(bodyOf(server, 2)).toEqual({ scroll: '1m', scroll_id: 's2' })
    expect(server.requests[3]!.method).toBe('DELETE')
    expect(bodyOf(server, 3)).toEqual({ scroll_id: 's2' })
    expect(server.requests).toHaveLength(4)
    expect((envelope(capture)['data'] as unknown[]).length).toBe(2)
    expect(envelope(capture)['meta']).toMatchObject({ count: 2, truncated: false })
  })

  test('rejects invalid flags before any request', async () => {
    const cases: string[][] = [
      ['query', '--index', 'x', '--sort', 'sideways', '--json'],
      ['query', '--index', 'x', '--since', 'notatime', '--json'],
      ['query', '--index', 'x', '--dsl', 'not json', '--json'],
      ['query', '--index', 'x', '--dsl', '{}', '--query', 'a', '--json'],
      ['query', '--index', 'x', '--dsl-file', join(scratch, 'nope.json'), '--json'],
      ['query', '--index', 'x', '--size', '0', '--json'],
    ]
    for (const argv of cases) {
      const server = configure([])
      const capture = await runCaptured(opensearchCommand, argv)
      expect(capture.code).toBe(2)
      expect(errorOf(capture)['kind']).toBe('usage')
      expect(server.requests).toHaveLength(0)
    }
  })
})
