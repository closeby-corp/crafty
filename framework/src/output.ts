/**
 * Shared output contract: envelopes, renderers, invocation context and failure
 * reporting. Routing and lifecycle execution live in command.ts.
 */
import { CliError, flag, option, write, writeErr, PROGRAM } from './cli.ts'
import type { OptionSpec, ParsedArgs, Values } from './cli.ts'
import { asOpsError, ConfigError, OpsError, usageError } from './errors.ts'
import { log, redactString, redactValue } from './log.ts'

export { flag, option, write, writeErr } from './cli.ts'

/** Accepted by every command, on top of `-c/--config` which the parser strips. */
export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: 'json', type: 'boolean' },
  { name: 'format', type: 'string', completion: ['json', 'plain', 'table', 'csv'] },
  { name: 'no-color', type: 'boolean' },
  { name: 'verbose', type: 'boolean', short: 'v' },
]

export type OutputFormat = 'auto' | 'plain' | 'table' | 'csv'

const FORMATS = ['json', 'plain', 'table', 'csv']

export interface Ctx {
  /** The data source the verb reads. */
  source: string
  /** The target the verb settled on, once it knows it. */
  target: string | null
  json: boolean
  format: OutputFormat
  color: boolean
  verbose: boolean
  startedAt: number
  /** `crafty <group> <verb>`, for error messages. */
  path: string
  /** The usage lines of the active verb, for usage errors. */
  usage: string[]
  values: Values
  positionals: string[]
  tail: string[]
  /** Values given for options declared repeatable. */
  repeat: Record<string, string[]>
  /** Sensitive option spellings on the selected command path, for explicit preview redaction. */
  sensitiveArgvOptions?: string[]
  /** Dynamic command segments captured along the selected path. */
  params: Record<string, string>
  /** Resources owned by this invocation's hooks and handler. */
  state: Record<string, unknown>
}

export interface Meta {
  count?: number
  truncated: boolean
  duration_ms: number
  /** Table columns, when the verb wants them fixed. */
  columns?: string[]
  [key: string]: unknown
}

export interface Envelope {
  ok: boolean
  source: string
  target: string | null
  data?: unknown
  meta: Meta
  error?: { kind: string; message: string; status: number | null; hint: string | null }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** JSON.stringify throws on BigInt, and ClickHouse counters arrive as BigInt. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString()
  }
  return value
}

export function emitEnvelope(envelope: Envelope): void {
  write(`${JSON.stringify(envelope, jsonReplacer, 2)}\n`)
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, jsonReplacer) ?? '-'
}

export function emitTable(rows: Record<string, unknown>[], columns: string[]): void {
  // A cell is one line: a log body's newlines would break the alignment, and
  // `--format csv` is there when the raw bytes matter.
  const cells = rows.map((row) => columns.map((column) => cellText(row[column]).replace(/\s*\n\s*/g, ' ')))
  const widths = columns.map((column, index) => Math.max(column.length, ...cells.map((row) => row[index]!.length)))
  const line = (values: string[]): string =>
    `${values.map((value, index) => value.padEnd(widths[index]!)).join('  ').trimEnd()}\n`
  write(`${line(columns)}${cells.map(line).join('')}`)
}

function csvField(value: unknown): string {
  const text = cellText(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function emitCsv(rows: Record<string, unknown>[], columns: string[]): void {
  const lines = [columns.map(csvField).join(',')]
  for (const row of rows) lines.push(columns.map((column) => csvField(row[column])).join(','))
  write(`${lines.join('\r\n')}\r\n`)
}

/** Every key the rows carry, in the order the rows introduce them. */
export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }
  return columns
}

export function plainText(data: unknown): string {
  if (data === null || data === undefined) return 'null\n'
  if (typeof data === 'string') return `${data}\n`
  if (typeof data !== 'object') return `${cellText(data)}\n`
  if (Array.isArray(data)) {
    if (data.length === 0) return ''
    const scalars = data.every((entry) => entry === null || typeof entry !== 'object')
    if (scalars) return `${data.map((entry) => cellText(entry)).join('\n')}\n`
    return `${data.map((entry) => JSON.stringify(entry, jsonReplacer)).join('\n')}\n`
  }
  const entries = Object.entries(data as Record<string, unknown>)
  if (entries.length === 0) return '{}\n'
  const width = Math.max(...entries.map(([key]) => key.length))
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${cellText(value)}\n`).join('')
}

export function emitResult(ctx: Ctx, data: unknown, meta: Partial<Meta> = {}): void {
  const rows = Array.isArray(data) ? data : undefined
  const isRowSet =
    rows !== undefined && rows.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  const resolved: Meta = {
    ...(rows !== undefined ? { count: rows.length } : {}),
    truncated: false,
    duration_ms: Date.now() - ctx.startedAt,
    ...meta,
  }

  if (ctx.json) {
    emitEnvelope({ ok: true, source: ctx.source, target: ctx.target, data, meta: resolved })
    return
  }

  if (isRowSet && ctx.format !== 'plain') {
    const table = rows as Record<string, unknown>[]
    if (table.length === 0) writeErr('no rows\n')
    else if (ctx.format === 'csv') emitCsv(table, resolved.columns ?? columnsOf(table))
    else emitTable(table, resolved.columns ?? columnsOf(table))
    if (resolved.truncated) writeErr(`note: output truncated to ${table.length} rows\n`)
    return
  }

  write(plainText(data))
}

/** ANSI colour for the few places a human needs a status to stand out. */
const TONES: Record<string, number> = { ok: 32, warn: 33, err: 31, muted: 90 }

export function paint(ctx: Ctx, tone: string, text: string): string {
  const code = TONES[tone]
  if (!ctx.color || code === undefined) return text
  return `\u001b[${code}m${text}\u001b[0m`
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

export function required(ctx: Ctx, name: string, what?: string): string {
  const value = option(ctx.values, name)
  if (value === undefined || value === '') throw usageError(`${what ?? `--${name}`} is required`)
  return value
}

export function intValue(ctx: Ctx, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = option(ctx.values, name)
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw usageError(`--${name} must be an integer of at least ${min}`, `got "${raw}"`)
  }
  return Math.min(value, max)
}

/** A comma-separated list option, trimmed and without empty entries. */
export function listValue(ctx: Ctx, name: string): string[] {
  const raw = option(ctx.values, name)
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export interface PlannedRequest {
  method?: string
  path?: string
  url?: string
  body?: unknown
  argv?: string[]
  /** Client-declared argv spellings whose values contain secrets (for previews only). */
  sensitiveArgvOptions?: readonly string[]
}

/**
 * A write runs only with `--yes`. `--dry-run` prints what would be sent, after
 * redaction, and stops before anything leaves the machine.
 */
export function gateMutation(ctx: Ctx, description: string, planned: PlannedRequest): 'proceed' | 'stop' {
  if (flag(ctx.values, 'dry-run')) {
    emitDryRun(ctx, description, planned)
    return 'stop'
  }
  if (flag(ctx.values, 'yes')) return 'proceed'
  throw usageError(`${description} changes remote state`, 're-run with --yes')
}

export function emitDryRun(ctx: Ctx, description: string, planned: PlannedRequest): void {
  const target = manifest(planned)
  if (ctx.json) {
    const previewCtx = {
      ...ctx,
      source: redactString(ctx.source),
      target: ctx.target === null ? null : redactString(ctx.target),
    }
    emitResult(previewCtx, { action: redactString(description), request: target }, { truncated: false })
    return
  }
  write(`dry-run: ${redactString(description)}\n`)
  write(plainText(target))
}

/** The shape `--dry-run` shows: redacted, because it can carry a body. */
export function manifest(planned: PlannedRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (planned.method !== undefined) out['method'] = planned.method
  if (planned.url !== undefined) out['url'] = redactString(planned.url)
  else if (planned.path !== undefined) out['path'] = redactString(planned.path)
  if (planned.argv !== undefined) out['command'] = redactArgv(planned.argv, planned.sensitiveArgvOptions).join(' ')
  if (planned.body !== undefined) out['body'] = redactValue(planned.body)
  return out
}

function redactArgv(argv: string[], declaredSensitiveOptions: readonly string[] = []): string[] {
  const sensitiveOptions = new Set(declaredSensitiveOptions.filter((option) => /^--?[^\s=]+$/.test(option)))
  const out: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const sensitiveLongOption = [...sensitiveOptions].find((option) =>
      option.startsWith('--') && (arg === option || arg.startsWith(`${option}=`)))
    const sensitiveShortOption = arg.startsWith('-') && !arg.startsWith('--')
      ? [...sensitiveOptions]
        .filter((option) => option.startsWith('-') && !option.startsWith('--') && option.length === 2)
        .map((option) => ({ option, index: arg.indexOf(option[1]!, 1) }))
        .filter(({ index }) => index !== -1)
        .sort((left, right) => left.index - right.index)[0]?.option
      : undefined
    const sensitiveOption = sensitiveLongOption ?? sensitiveShortOption
    const automaticSensitiveOption =
      /^--?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|(?:[\w-]*[_-])?(?:token|secret|password|credential|authorization|api[_-]?key))$/i.test(arg)
    if (sensitiveOption && arg !== sensitiveOption) {
      if (sensitiveOption.startsWith('-') && !sensitiveOption.startsWith('--')) {
        const aliasIndex = arg.indexOf(sensitiveOption[1]!, 1)
        if (aliasIndex !== -1) {
          const prefix = arg.slice(0, aliasIndex + 1)
          const attached = arg.slice(aliasIndex + 1)
          out.push(`${prefix}${attached ? '[redacted]' : ''}`)
          if (!attached && argv[index + 1] !== undefined) {
            out.push('[redacted]')
            index += 1
          }
          continue
        }
      }
      const separator = arg.startsWith(`${sensitiveOption}=`) ? '=' : ''
      out.push(`${sensitiveOption}${separator}[redacted]`)
      continue
    }
    out.push(redactString(arg))
    if (automaticSensitiveOption || sensitiveOption) {
      const value = argv[index + 1]
      if (value !== undefined) {
        out.push('[redacted]')
        index += 1
      }
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Invocation context
 * ------------------------------------------------------------------ */

export interface CommandInfo {
  source: string
  path: string
  usage: string[]
}

export function makeCtx(info: CommandInfo, parsed: ParsedArgs, repeat: Record<string, string[]>): Ctx {
  const format = option(parsed.values, 'format')
  if (format !== undefined && !FORMATS.includes(format)) {
    throw usageError(`unknown --format "${format}"`, `formats: ${FORMATS.join(', ')}`)
  }
  const json = flag(parsed.values, 'json') || format === 'json'
  return {
    source: info.source,
    target: null,
    json,
    format: (json ? 'auto' : (format ?? 'auto')) as OutputFormat,
    color: !flag(parsed.values, 'no-color') && process.stdout.isTTY === true,
    verbose: flag(parsed.values, 'verbose'),
    startedAt: Date.now(),
    path: info.path,
    usage: info.usage,
    values: parsed.values,
    positionals: parsed.positionals,
    tail: parsed.tail,
    repeat,
    sensitiveArgvOptions: [],
    params: Object.create(null),
    state: Object.create(null),
  }
}

/**
 * `--param k=v` and `--param=k=v` can both be repeated. They are lifted out of
 * argv before the framework's parser sees them, which is the only way to keep
 * more than the last value.
 */
export function pullRepeatable(
  argv: string[],
  names: string[],
  options: readonly OptionSpec[] = [],
): { argv: string[]; repeat: Record<string, string[]> } {
  const repeatNames = new Set(names)
  const repeatShorts = new Map<string, string>()
  const stringShorts = new Map<string, string>()
  for (const option of options) {
    if (option.type === 'string' && option.short) stringShorts.set(option.short, option.name)
    if (option.repeatable) {
      repeatNames.add(option.name)
    }
    if (option.type === 'string' && option.short && repeatNames.has(option.name)) repeatShorts.set(option.short, option.name)
  }
  if (repeatNames.size === 0) return { argv, repeat: {} }
  const separator = argv.indexOf('--')
  const head = separator === -1 ? argv : argv.slice(0, separator)
  const tail = separator === -1 ? [] : argv.slice(separator + 1)
  const keep: string[] = []
  const repeat: Record<string, string[]> = {}
  const appendRepeat = (name: string, value: string): void => {
    const previous = Object.prototype.hasOwnProperty.call(repeat, name) ? repeat[name]! : []
    Object.defineProperty(repeat, name, {
      value: [...previous, value], enumerable: true, configurable: true, writable: true,
    })
  }
  for (let index = 0; index < head.length; index += 1) {
    const arg = head[index]!
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=')
      const name = arg.slice(2, equals === -1 ? undefined : equals)
      if (!repeatNames.has(name)) { keep.push(arg); continue }
      const value = equals === -1 ? head[index + 1] : arg.slice(equals + 1)
      if (value === undefined) throw usageError(`--${name} needs a value`)
      appendRepeat(name, value)
      if (equals === -1) index += 1
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      let repeated = false
      for (let shortIndex = 1; shortIndex < arg.length; shortIndex += 1) {
        const name = repeatShorts.get(arg[shortIndex]!)
        if (!name) {
          // A string option owns the rest of its short cluster, including text
          // that happens to contain a repeatable option's alias.
          if (stringShorts.has(arg[shortIndex]!)) break
          continue
        }
        const attached = arg.slice(shortIndex + 1)
        const value = attached || head[index + 1]
        if (value === undefined) throw usageError(`-${arg[shortIndex]} needs a value`)
        appendRepeat(name, value)
        if (!attached) index += 1
        const prefix = arg.slice(0, shortIndex)
        if (prefix.length > 1) keep.push(prefix)
        repeated = true
        break
      }
      if (repeated) continue
    }
    keep.push(arg)
  }
  return { argv: separator === -1 ? keep : [...keep, '--', ...tail], repeat }
}

export function reportFailure(error: unknown, info: CommandInfo, ctx: Ctx | null, argv: string[], program = PROGRAM): number {
  const ops =
    error instanceof CliError
      ? new OpsError(error.message, error.exitCode === 2 ? 'usage' : 'internal')
      : asOpsError(error)
  ops.at(info.source, ctx?.target)
  const json = ctx?.json ?? looksJson(argv)
  const path = ctx?.path ?? info.path
  const message = redactString(ops.message)
  const hint = ops.hint === undefined ? undefined : redactString(ops.hint)

  if (json) {
    emitEnvelope({
      ok: false,
      source: redactString(ops.source ?? info.source),
      target: ops.target === null ? null : redactString(ops.target),
      meta: { truncated: false, duration_ms: ctx === null ? 0 : Date.now() - ctx.startedAt },
      error: { kind: ops.kind, message, status: ops.status ?? null, hint: hint ?? null },
    })
    return ops.exitCode
  }

  if (ops instanceof ConfigError) {
    writeErr(`${redactString(program)} config: ${redactString(ops.path)} has ${ops.problems.length} problem(s)\n`)
    for (const line of message.split('\n')) writeErr(`  ${line}\n`)
    return ops.exitCode
  }

  writeErr(`${redactString(path)}: ${message}\n`)
  if (hint !== undefined) writeErr(`hint: ${hint}\n`)
  if (ops.kind === 'usage') writeErr(`\n${(ctx?.usage ?? info.usage).map(redactString).join('\n')}\n`)
  if (ops.kind === 'internal') log.error('command failed', { command: path, error: message })
  return ops.exitCode
}

/** Which envelope a failure gets, when nothing has been parsed yet. */
function looksJson(argv: string[]): boolean {
  const separator = argv.indexOf('--')
  const head = separator === -1 ? argv : argv.slice(0, separator)
  return head.some(
    (arg, index) => arg === '--json' || arg === '--format=json' || (arg === '--format' && head[index + 1] === 'json'),
  )
}
