import { OpsError } from './errors.ts'

export interface TimePoint {
  ms: number
  iso: string
  seconds: number
}

const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const RELATIVE = /^(\d+(?:\.\d+)?)(s|m|h|d|w)$/
const INTEGERS = /^\d+$/
/** Bare numbers at or above this are epoch seconds, not a count of seconds ago. */
const EPOCH_THRESHOLD = 1_000_000_000

export function timePoint(ms: number): TimePoint {
  return { ms, iso: new Date(ms).toISOString(), seconds: Math.floor(ms / 1000) }
}

/**
 * The lower edge of a window. Relative forms (`90s`, `15m`, `12h`, `7d`, `2w`, a
 * bare count of seconds) count back from `now`; ISO-8601 timestamps and bare
 * epoch seconds (ten digits or more) are absolute instants.
 */
export function parseSince(value: string, now: number = Date.now()): TimePoint {
  const text = value.trim()
  const relative = RELATIVE.exec(text)
  if (relative) return timePoint(now - Number(relative[1]) * UNITS[relative[2] as string]!)

  if (INTEGERS.test(text)) {
    const number = Number(text)
    if (number >= EPOCH_THRESHOLD) return timePoint(number * 1000)
    return timePoint(now - number * 1000)
  }

  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new OpsError(`cannot read the time "${value}"`, 'usage', {
      hint: 'use 90s, 15m, 12h, 7d, 2w, a count of seconds, an ISO-8601 timestamp or epoch seconds',
    })
  }
  return timePoint(parsed)
}

/** The upper edge, defaulting to now. */
export function parseUntil(value: string | undefined, now: number = Date.now()): TimePoint {
  if (value === undefined || value === '') return timePoint(now)
  return parseSince(value, now)
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m${totalSeconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

/** Step sizes Prometheus is happy with, coarse enough to keep the series small. */
const STEPS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400]
const MAX_POINTS = 1_000

export interface PromRange {
  start: string
  end: string
  step: string
}

/** One `query_range` window: epoch seconds as the API wants them, plus a step. */
export function toPromRange(from: TimePoint, to: TimePoint, step?: string): PromRange {
  const windowMs = Math.max(0, to.ms - from.ms)
  return {
    start: String(from.seconds),
    end: String(to.seconds),
    step: step ?? String(pickStep(windowMs)),
  }
}

export function pickStep(windowMs: number): number {
  const wanted = Math.max(1, windowMs / 1_000 / MAX_POINTS)
  return STEPS.find((candidate) => candidate >= wanted) ?? STEPS[STEPS.length - 1]!
}

/** Relative forms keep their `now-` spelling where the upstream API expects one. */
export function toGrafanaFrom(since: TimePoint, now: number = Date.now()): string {
  const ms = now - since.ms
  if (ms <= 0) return 'now'
  return `now-${Math.max(1, Math.round(ms / 1_000))}s`
}
