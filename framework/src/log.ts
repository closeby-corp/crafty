import { AsyncLocalStorage } from 'node:async_hooks'
import { writeError } from './io.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const knownSecrets = new Set<string>()
const secretScope = new AsyncLocalStorage<Set<string>>()
const secretKeyPattern = /token|secret|password|credential|authorization|api[_-]?key/i

/** Register a non-empty value that must never appear in logs. */
export function registerSecret(value: string | undefined | null): void {
  if (!value) return
  const local = secretScope.getStore()
  if (local) local.add(value)
  else knownSecrets.add(value)
}

/** Keep nested calls in one invocation on its current secret set. */
export function withSecretScope<T>(callback: () => T): T {
  return secretScope.run(secretScope.getStore() ?? new Set(knownSecrets), callback)
}

/** Start an independent invocation, even when the caller has an ambient scope. */
export function withIsolatedSecretScope<T>(callback: () => T): T {
  return secretScope.run(new Set(knownSecrets), callback)
}

export function redactString(text: string): string {
  let out = text
  const secrets = new Set([...knownSecrets, ...(secretScope.getStore() ?? [])])
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]')
  }
  return out
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [redacted]')
    // Userinfo is sensitive even when its password was never registered.
    .replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[redacted]@')
    // Cover secrets embedded in command-line strings, URLs, and diagnostic text.
    .replace(
      /(^|[^\w-])(--)?(access[_-]?token|refresh[_-]?token|client[_-]?secret|(?:[\w-]*[_-])?(?:token|secret|password|credential|authorization|api[_-]?key))\b(\s*(?:=|:)\s*|\s+)("[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      (match, prefix: string, optionPrefix: string | undefined, key: string, separator: string) => {
        // In prose, a bare word such as "token expired" is not a key/value.
        if (!optionPrefix && /^\s+$/.test(separator)) return match
        return `${prefix}${optionPrefix ?? ''}${key}${separator}[redacted]`
      },
    )
}

export function redactValue(value: unknown, key?: string): unknown {
  if (key && secretKeyPattern.test(key)) return '[redacted]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry))
  if (value instanceof Error) return redactString(value.message)
  if (value instanceof Date) return new Date(value.getTime())
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
  // Keep diagnostics off stdout and honor any request-local capture sink.
  writeError(`${line}\n`)
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit('error', message, fields),
}
