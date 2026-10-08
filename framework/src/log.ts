export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const knownSecrets = new Set<string>()
const secretKeyPattern = /token|secret|password|credential|authorization/i

/**
 * Register a value that must never appear in logs. Values shorter than 8
 * characters are ignored because masking them would destroy log readability
 * for no real benefit.
 */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) knownSecrets.add(value)
}

export function redactString(text: string): string {
  let out = text
  for (const secret of knownSecrets) out = out.split(secret).join('[redacted]')
  return out.replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]')
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && secretKeyPattern.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (value instanceof Error) return redactString(value.message)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, k)]),
    )
  }
  return value
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: redactString(message),
    ...(fields ? (redactValue(fields) as Record<string, unknown>) : {}),
  })
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
}
