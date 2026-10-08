/**
 * One probe per source: the cheapest call that proves a target is reachable
 * *and* authorised. `crafty doctor` reports them, so a missing credential is told
 * apart from a service that is down before a verb is trusted.
 *
 * A probe reuses the verb path of its own source module, so it can never drift
 * from what a real call does.
 */
import { asOpsError, OpsError } from 'crafty'
import { httpRequest } from './http.ts'
import { sshRun } from './ssh.ts'
import { probeDb } from '../commands/db.ts'
import { runSql } from '../commands/signoz.ts'
import type { Settings, Target } from './targets.ts'

export type ProbeStatus = 'ok' | 'auth' | 'unreachable' | 'error'

export interface ProbeResult {
  target: string
  kind: string
  status: ProbeStatus
  detail: string
  duration_ms: number
}

const STATUS_BY_KIND: Record<string, ProbeStatus> = {
  auth: 'auth',
  network: 'unreachable',
  config: 'error',
  usage: 'error',
  'not-found': 'error',
  conflict: 'error',
  'rate-limit': 'error',
  upstream: 'error',
  remote: 'error',
  internal: 'error',
}

function statusForError(error: OpsError): ProbeStatus {
  return STATUS_BY_KIND[error.kind] ?? 'error'
}

function detailOf(json: unknown, keys: string[]): string {
  if (json === null || typeof json !== 'object') return 'answered'
  const record = json as Record<string, unknown>
  const parts: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null && typeof value !== 'object') parts.push(`${key} ${String(value)}`)
    else if (value !== null && typeof value === 'object') {
      const nested = Object.entries(value as Record<string, unknown>)
        .filter(([, inner]) => typeof inner === 'string' || typeof inner === 'number')
        .slice(0, 3)
        .map(([innerKey, inner]) => `${key}.${innerKey}=${String(inner)}`)
      parts.push(...nested)
    }
  }
  return parts.length === 0 ? 'answered' : parts.join(', ')
}

/** The probe body, per kind. Throws on anything that is not a healthy answer. */
async function probe(target: Target, settings: Settings): Promise<string> {
  switch (target.kind) {
    case 'opensearch': {
      const response = await httpRequest(target, { method: 'GET', path: '/_cluster/health' }, settings)
      return detailOf(response.json, ['cluster_name', 'status', 'number_of_nodes'])
    }
    case 'kibana': {
      const response = await httpRequest(target, { method: 'GET', path: '/api/status' }, settings)
      return detailOf(response.json, ['version', 'status'])
    }
    case 'prometheus': {
      const response = await httpRequest(target, { method: 'GET', path: '/api/v1/status/buildinfo' }, settings)
      return detailOf(response.json, ['data'])
    }
    case 'grafana': {
      const response = await httpRequest(target, { method: 'GET', path: '/api/health' }, settings)
      return detailOf(response.json, ['version', 'database'])
    }
    case 'signoz': {
      const rows = await runSql(target, 'SHOW DATABASES')
      return `${rows.length} database(s)`
    }
    case 'db': {
      const { ok, detail } = await probeDb(target, settings)
      if (!ok) {
        throw new OpsError(detail, /authentication failed|no password supplied|password/i.test(detail) ? 'auth' : 'upstream')
      }
      return detail
    }
    case 'bitbucket': {
      const response = await httpRequest(target, { method: 'GET', path: '/user' }, settings)
      return detailOf(response.json, ['display_name', 'nickname', 'uuid'])
    }
    case 'jira': {
      const response = await httpRequest(target, { method: 'GET', path: '/rest/api/3/myself' }, settings)
      return detailOf(response.json, ['displayName', 'emailAddress', 'accountId'])
    }
  }
}

export async function probeTarget(target: Target, settings: Settings): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const detail = await probe(target, settings)
    return { target: target.name, kind: target.kind, status: 'ok', detail, duration_ms: Date.now() - startedAt }
  } catch (error) {
    const ops = asOpsError(error)
    return {
      target: target.name,
      kind: target.kind,
      status: statusForError(ops),
      detail: ops.message,
      duration_ms: Date.now() - startedAt,
    }
  }
}

/** The `[ssh].hosts` entries are targets too, for `crafty doctor`. */
export async function probeSshHost(host: string, settings: Settings): Promise<ProbeResult> {
  const startedAt = Date.now()
  try {
    const result = await sshRun(host, ['true'], { timeoutMs: settings.timeout_ms, allowFailure: true })
    const ok = result.exitCode === 0
    return {
      target: host,
      kind: 'ssh',
      status: ok ? 'ok' : result.stderr.includes('Permission denied') ? 'auth' : 'error',
      detail: ok ? 'ssh answered' : result.stderr.trim().slice(0, 200) || `exit ${result.exitCode}`,
      duration_ms: Date.now() - startedAt,
    }
  } catch (error) {
    const ops = asOpsError(error)
    return {
      target: host,
      kind: 'ssh',
      status: statusForError(ops),
      detail: ops.message,
      duration_ms: Date.now() - startedAt,
    }
  }
}
