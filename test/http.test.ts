import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { authHeaders, requestInit } from '../src/http.ts'
import { DEFAULT_SETTINGS } from '../src/targets.ts'
import type { GrafanaTarget } from '../src/targets.ts'

function target(overrides: Partial<GrafanaTarget> = {}): GrafanaTarget {
  return { name: 'graf', kind: 'grafana', base_url: 'https://grafana.example.com', auth: 'none', ...overrides }
}

afterEach(() => {
  // the module remembers which targets it warned about, by name
})

describe('the Authorization header', () => {
  test('an inline credential is used, and a bearer target sends it verbatim', async () => {
    const headers = await authHeaders(target({ auth: 'basic', username: 'reader', password: 'from-the-file' } as never))
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('reader:from-the-file').toString('base64')}`)

    const bearer = await authHeaders(target({ auth: 'bearer', token: 'glsa_abc' } as never))
    expect(bearer['Authorization']).toBe('Bearer glsa_abc')
  })

  test('a target with nothing to send says where a credential would come from', async () => {
    try {
      await authHeaders(target({ name: 'grafana-bi', auth: 'basic', username: 'ops', secret: 'grafana-bi' } as never))
      throw new Error('expected an auth error')
    } catch (error) {
      expect((error as { kind?: string }).kind).toBe('auth')
      expect((error as { hint?: string }).hint).toContain('export OPS_SECRET_GRAFANA_BI')
    }
  })

  test('auth = none sends no header at all', async () => {
    expect(await authHeaders(target({ auth: 'none' } as never))).toEqual({})
  })
})

describe('the request a target produces', () => {
  test('asks for the body only when the method carries one', () => {
    const settings = DEFAULT_SETTINGS
    const get = requestInit(target(), { method: 'GET', path: '/api/health' }, settings, {})
    expect(get.method).toBe('GET')
    expect(get.body).toBeUndefined()
    expect(get.signal).toBeDefined()

    const post = requestInit(
      target(),
      { method: 'POST', path: '/api/ds/query', body: { queries: [] } },
      settings,
      { 'Content-Type': 'application/json' },
    )
    expect(post.body).toBe(JSON.stringify({ queries: [] }))
  })

  test('verifies the certificate unless the target says not to', () => {
    const strict = requestInit(target(), { method: 'GET', path: '/x' }, DEFAULT_SETTINGS, {})
    expect(strict.tls).toBeUndefined()

    const insecure = requestInit(
      target({ name: 'grafana-bi', tls_insecure: true }),
      { method: 'GET', path: '/x' },
      DEFAULT_SETTINGS,
      {},
    )
    expect(insecure.tls).toEqual({ rejectUnauthorized: false })
  })

  test('announces the bypass once, on stderr, and only for that target', () => {
    const writes: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    try {
      const insecure = target({ name: 'warned-once-target', tls_insecure: true })
      requestInit(insecure, { method: 'GET', path: '/x' }, DEFAULT_SETTINGS, {})
      requestInit(insecure, { method: 'GET', path: '/y' }, DEFAULT_SETTINGS, {})
      requestInit(target({ name: 'strict-target' }), { method: 'GET', path: '/x' }, DEFAULT_SETTINGS, {})
    } finally {
      spy.mockRestore()
    }
    const warnings = writes.filter((line) => line.includes('tls_insecure'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('warned-once-target')
    expect(warnings[0]).toContain('not verified')
  })

  test('the timeout comes from settings, per request', () => {
    const init = requestInit(target(), { method: 'GET', path: '/x' }, { ...DEFAULT_SETTINGS, timeout_ms: 1_234 }, {})
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
