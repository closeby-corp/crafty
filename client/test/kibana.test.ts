import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import kibanaCommand from '../commands/kibana.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { isTable } from '../lib/values.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { startMockServer } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-kibana-'))

interface ConfigOptions {
  defaultIndex?: string
  auth?: 'none' | 'basic' | 'bearer'
}

/**
 * Points `OPS_CONFIG` at a one-target YAML file. The cache is dropped after
 * writing so the verb reads this file, not a previous test's.
 */
function writeConfig(baseUrl: string, options: ConfigOptions = {}): void {
  const lines = ['targets:', '  kib:', '    kind: kibana', `    base_url: "${baseUrl}"`, `    auth: ${options.auth ?? 'none'}`]
  if (options.auth === 'basic') lines.push('    username: ops', '    secret: mock')
  if (options.defaultIndex !== undefined) lines.push(`    default_index: "${options.defaultIndex}"`)
  const path = join(scratch, 'config.yml')
  writeFileSync(path, `${lines.join('\n')}\n`)
  process.env['OPS_CONFIG'] = path
  resetConfigCache()
}

afterEach(() => {
  // Both are process-wide: leaving them set would reach every later test file.
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_MOCK']
  resetConfigCache()
})

beforeEach(() => {
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_MOCK']
  resetConfigCache()
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

/** A JSON object, narrowed without a cast. */
function objectOf(value: unknown): Record<string, unknown> {
  if (!isTable(value)) throw new Error(`expected an object, got ${typeof value}`)
  return value
}

describe('ops kibana status', () => {
  test('asks /api/status and flattens version and overall level', async () => {
    const server = startMockServer([
      {
        path: '/api/status',
        body: {
          name: 'kib-1',
          version: { number: '8.13.4' },
          status: { overall: { level: 'available', summary: 'All services are available' } },
        },
      },
    ])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['status', '--json'])

    expect(capture.code).toBe(0)
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/api/status' })
    expect(envelope(capture)['data']).toEqual({
      name: 'kib-1',
      version: '8.13.4',
      status: 'available',
      summary: 'All services are available',
    })
    expect(envelope(capture)['target']).toBe('kib')
  })

  test('a 401 maps to kind auth and exit 3', async () => {
    const server = startMockServer([{ path: '/api/status', status: 401, body: { message: 'Unauthorized' } }])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['status', '--json'])

    expect(capture.code).toBe(3)
    expect(errorOf(capture)['kind']).toBe('auth')
    expect(errorOf(capture)['status']).toBe(401)
  })
})

describe('ops kibana spaces', () => {
  test('lists one row per space', async () => {
    const server = startMockServer([
      {
        path: '/api/spaces/space',
        body: [
          { id: 'default', name: 'Default', description: 'Default space' },
          { id: 'iag', name: 'IAG', description: 'BSA team' },
        ],
      },
    ])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['spaces', '--json'])

    expect(capture.code).toBe(0)
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/api/spaces/space' })
    expect(envelope(capture)['data']).toEqual([
      { id: 'default', name: 'Default', description: 'Default space' },
      { id: 'iag', name: 'IAG', description: 'BSA team' },
    ])
  })

  test('a 404 maps to kind not-found and exit 1', async () => {
    const server = startMockServer([{ path: '/api/spaces/space', status: 404, body: { message: 'Not Found' } }])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['spaces', '--json'])

    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('not-found')
    expect(errorOf(capture)['status']).toBe(404)
  })
})

describe('ops kibana saved', () => {
  test('asks _find with the type and per_page, and lifts the title', async () => {
    const server = startMockServer([
      {
        path: '/api/saved_objects/_find',
        body: {
          saved_objects: [
            { id: 'a', type: 'dashboard', attributes: { title: 'Signoz' } },
            { id: 'b', type: 'dashboard', attributes: { title: 'Postgres' } },
          ],
        },
      },
    ])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['saved', '--type', 'dashboard', '--size', '5', '--json'])

    expect(capture.code).toBe(0)
    expect(server.requests[0]?.path).toBe('/api/saved_objects/_find')
    const params = new URLSearchParams(server.requests[0]?.query ?? '')
    expect(params.get('type')).toBe('dashboard')
    expect(params.get('per_page')).toBe('5')
    expect(envelope(capture)['data']).toEqual([
      { id: 'a', type: 'dashboard', title: 'Signoz' },
      { id: 'b', type: 'dashboard', title: 'Postgres' },
    ])
  })

  test('--search adds the search parameter', async () => {
    const server = startMockServer([{ path: '/api/saved_objects/_find', body: { saved_objects: [] } }])
    writeConfig(server.url)

    await runCaptured(kibanaCommand, ['saved', '--type', 'search', '--search', 'lastmile'])

    const params = new URLSearchParams(server.requests[0]?.query ?? '')
    expect(params.get('search')).toBe('lastmile')
    expect(params.get('per_page')).toBe('20')
  })

  test('an unknown type is a usage error before any request', async () => {
    const server = startMockServer([])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['saved', '--type', 'nope', '--json'])

    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests).toHaveLength(0)
  })
})

describe('ops kibana query', () => {
  test('proxies the search with kbn-xsrf and a query_string body', async () => {
    const server = startMockServer([
      {
        path: '/api/console/proxy',
        body: { hits: { hits: [{ _index: 'logs-2026', _id: '1', _source: { message: 'boom' } }] } },
      },
    ])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['query', '--index', 'logs-*', '--query', 'boom', '--json'])

    expect(capture.code).toBe(0)
    const request = server.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/api/console/proxy')
    expect(request.headers['kbn-xsrf']).toBe('true')
    const params = new URLSearchParams(request.query)
    expect(params.get('path')).toBe('logs-*/_search')
    expect(params.get('method')).toBe('POST')

    const body = objectOf(JSON.parse(request.body) as unknown)
    expect(body['size']).toBe(50)
    const bool = objectOf(objectOf(body['query'])['bool'])
    expect(bool['must']).toEqual([{ query_string: { query: 'boom', analyze_wildcard: true } }])
    const filter = bool['filter'] as unknown[]
    expect(filter).toHaveLength(1)
    const range = objectOf(objectOf(objectOf(filter[0])['range'])['@timestamp'])
    expect(typeof range['gte']).toBe('string')

    expect(envelope(capture)['data']).toEqual([{ _index: 'logs-2026', _id: '1', _source: { message: 'boom' } }])
  })

  test('--index falls back to the target default_index', async () => {
    const server = startMockServer([{ path: '/api/console/proxy', body: { hits: { hits: [] } } }])
    writeConfig(server.url, { defaultIndex: 'filebeat-*' })

    const capture = await runCaptured(kibanaCommand, ['query', '--query', 'x', '--json'])

    expect(capture.code).toBe(0)
    expect(new URLSearchParams(server.requests[0]?.query ?? '').get('path')).toBe('filebeat-*/_search')
  })

  test('--dsl replaces the body but keeps size', async () => {
    const server = startMockServer([{ path: '/api/console/proxy', body: { hits: { hits: [] } } }])
    writeConfig(server.url, { defaultIndex: 'filebeat-*' })

    await runCaptured(kibanaCommand, ['query', '--dsl', '{"query":{"match_all":{}}}', '--size', '7'])

    expect(objectOf(JSON.parse(server.requests[0]!.body) as unknown)).toEqual({ size: 7, query: { match_all: {} } })
  })

  test('a target without default_index and no --index is a usage error', async () => {
    const server = startMockServer([])
    writeConfig(server.url)

    const capture = await runCaptured(kibanaCommand, ['query', '--query', 'x', '--json'])

    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests).toHaveLength(0)
  })

  test('--query with --dsl is a usage error', async () => {
    const server = startMockServer([])
    writeConfig(server.url, { defaultIndex: 'filebeat-*' })

    const capture = await runCaptured(kibanaCommand, ['query', '--query', 'x', '--dsl', '{}', '--json'])

    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests).toHaveLength(0)
  })

  test('basic auth sends the Authorization header from the secret store', async () => {
    const server = startMockServer([{ path: '/api/console/proxy', body: { hits: { hits: [] } } }])
    writeConfig(server.url, { defaultIndex: 'filebeat-*', auth: 'basic' })
    process.env['OPS_SECRET_MOCK'] = 'hunter2'

    await runCaptured(kibanaCommand, ['query', '--query', 'x'])

    expect(server.requests[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('ops:hunter2').toString('base64')}`,
    )
  })
})
