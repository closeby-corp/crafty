/**
 * One HTTP client for every source that speaks REST: credentials come from the
 * secret store, failures become the kind/status/hint triple the envelope wants,
 * and only safe calls are retried.
 */
import { writeErr } from './cli.ts'
import { kindForSystemCode, kindForStatus, OpsError, errorMessage } from './errors.ts'
import { redactString } from './log.ts'
import { jsonReplacer } from './output.ts'
import { secretEnvName, targetCredential } from './secrets.ts'
import { DEFAULT_SETTINGS } from './targets.ts'
import { VERSION } from './version.ts'
import type { HttpTarget, Settings } from './targets.ts'

export interface HttpRequest {
  method: string
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  accept?: string
  headers?: Record<string, string>
  /** Calls the API documents as repeatable: the search endpoints. */
  retryable?: boolean
}

export interface HttpResponse {
  status: number
  json?: unknown
  text: string
  durationMs: number
  url: string
}

const RETRY_STATUSES: readonly number[] = [429, 502, 503, 504]
const MAX_RETRIES = 2
const MAX_RETRY_DELAY_MS = 10_000

/** Set by the dispatcher so `-v` can trace without every call site knowing. */
let traceSink: ((line: string) => void) | null = null

export function setTraceSink(sink: ((line: string) => void) | null): void {
  traceSink = sink
}

function trace(message: string): void {
  traceSink?.(`${redactString(message)}\n`)
}

export function buildUrl(
  target: HttpTarget,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(`${target.base_url.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** The Authorization header, or none. The secret never reaches a log line. */
export async function authHeaders(target: HttpTarget): Promise<Record<string, string>> {
  const headers: Record<string, string> = {}
  if (target.auth === 'none') return { ...headers, ...target.headers }

  const credential = targetCredential(target.kind, target)
  if (credential === null) {
    const ways = [
      `${target.password === undefined && target.token === undefined ? 'write `password:` (or `token:`) in its target' : ''}`,
      target.secret === undefined ? '' : `export ${secretEnvName(target.secret)}`,
    ].filter((way) => way !== '')
    throw new OpsError(`${target.name} has no credential`, 'auth', {
      hint: ways.length === 0 ? 'the config file holds one, so check the file is readable' : `${ways.join(', or ')}`,
    })
  }
  const secret = credential.value

  if (target.auth === 'bearer') headers['Authorization'] = `Bearer ${secret}`
  else {
    if (target.username === undefined) {
      throw new OpsError(`${target.name} uses basic auth but has no username`, 'config')
    }
    headers['Authorization'] = `Basic ${Buffer.from(`${target.username}:${secret}`).toString('base64')}`
  }
  return { ...headers, ...target.headers }
}

/**
 * The order the sources put their message in: Bitbucket, Jira, ES, Grafana,
 * Prometheus. A body-less failure says nothing useful, so the caller's fallback
 * (the HTTP status) is used instead.
 */
export function extractMessage(json: unknown, text: string, fallback = 'the server answered without a body'): string {
  const bare = text.trim().slice(0, 500) === '' ? fallback : text.trim().slice(0, 500)
  if (json !== null && typeof json === 'object') {
    const body = json as Record<string, unknown>
    const nested = body['error']
    if (nested !== null && typeof nested === 'object') {
      const message = (nested as Record<string, unknown>)['message']
      if (typeof message === 'string') return message
      const reason = (nested as Record<string, unknown>)['reason']
      if (typeof reason === 'string') return reason
    }
    if (typeof nested === 'string') return nested
    if (typeof body['message'] === 'string') return body['message']
    for (const key of ['errors', 'errorMessages']) {
      const list = body[key]
      if (Array.isArray(list) && list.length > 0) {
        const first = list[0]
        if (typeof first === 'string') return first
        if (first !== null && typeof first === 'object') {
          const entry = first as Record<string, unknown>
          const detail = entry['message'] ?? entry['detail']
          if (typeof detail === 'string') return detail
        }
      }
    }
  }
  return bare
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** `Retry-After` as seconds or as an HTTP date, capped so a retry stays quick. */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header !== null) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS)
    const at = Date.parse(header)
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_DELAY_MS)
  }
  const backoff = 250 * 2 ** attempt
  return backoff + Math.round((Math.random() - 0.5) * 100)
}

function shouldRetry(request: HttpRequest, status: number, attempt: number): boolean {
  const safe = request.method === 'GET' || request.retryable === true
  return safe && attempt < MAX_RETRIES && RETRY_STATUSES.includes(status)
}

/** `tls` is Bun's extension to `RequestInit`, and the only way to skip a check. */
export interface BunRequestInit extends RequestInit {
  tls?: { rejectUnauthorized: boolean }
}

/**
 * The request as `fetch` wants it. A target that says `tls_insecure: true` gets a
 * bypass for a certificate this machine cannot verify - a private CA or a
 * self-signed one - which is why its use is announced once per target.
 */
export function requestInit(
  target: HttpTarget,
  request: HttpRequest,
  settings: Settings,
  headers: Record<string, string>,
): BunRequestInit {
  warnInsecureOnce(target)
  return {
    method: request.method,
    headers,
    body: request.body === undefined || request.method === 'GET' ? undefined : JSON.stringify(request.body, jsonReplacer),
    signal: AbortSignal.timeout(settings.timeout_ms),
    ...(target.tls_insecure === true ? { tls: { rejectUnauthorized: false } } : {}),
  }
}

const insecureWarned = new Set<string>()

function warnInsecureOnce(target: HttpTarget): void {
  if (target.tls_insecure !== true || insecureWarned.has(target.name)) return
  insecureWarned.add(target.name)
  writeErr(`warning: ${target.name} is configured with tls_insecure: true, so its certificate is not verified\n`)
}

export async function send(
  target: HttpTarget,
  request: HttpRequest,
  settings: Settings,
): Promise<Response> {
  const url = buildUrl(target, request.path, request.query)
  const headers: Record<string, string> = {
    'User-Agent': `crafty/${VERSION} bun/${Bun.version}`,
    Accept: request.accept ?? 'application/json',
    ...(await authHeaders(target)),
    ...request.headers,
  }
  if (request.body !== undefined) headers['Content-Type'] ??= 'application/json'

  try {
    return await fetch(url, requestInit(target, request, settings, headers))
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const code = (error as { code?: string }).code
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new OpsError(`${request.method} ${request.path} timed out after ${settings.timeout_ms}ms`, 'network', {
        hint: 'raise settings.timeout_ms',
      })
    }
    throw new OpsError(`${request.method} ${request.path} failed: ${errorMessage(error)}`, kindForSystemCode(code), {
      cause: error,
    })
  }
}

export async function httpRequest(
  target: HttpTarget,
  request: HttpRequest,
  settings: Settings = DEFAULT_SETTINGS,
): Promise<HttpResponse> {
  let attempt = 0
  for (;;) {
    const startedAt = Date.now()
    const response = await send(target, request, settings)
    const text = await response.text()
    const durationMs = Date.now() - startedAt
    const url = buildUrl(target, request.path, request.query)
    trace(`${request.method} ${url} -> ${response.status} in ${durationMs}ms`)

    if (shouldRetry(request, response.status, attempt)) {
      const delay = retryAfterMs(response, attempt)
      trace(`${request.method} ${url} -> ${response.status}; retrying in ${delay}ms`)
      await Bun.sleep(delay)
      attempt += 1
      continue
    }

    const json = parseJson(text)
    if (response.status >= 400) {
      const fallback = `${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`
      throw new OpsError(extractMessage(json, text, fallback), kindForStatus(response.status), {
        status: response.status,
        target: target.name,
      })
    }
    return {
      status: response.status,
      ...(json === undefined ? {} : { json }),
      text,
      durationMs,
      url,
    }
  }
}

/** A request that must not be sent unless the operator asked for the write. */
export function plannedRequest(target: HttpTarget, request: HttpRequest): { method: string; path: string; body?: unknown } {
  return {
    method: request.method,
    path: buildUrl(target, request.path, request.query),
    ...(request.body === undefined ? {} : { body: request.body }),
  }
}
