/**
 * The failure vocabulary every layer shares: the `kind` names what went wrong,
 * and the kind alone decides the process exit code.
 */
export type ErrorKind =
  | 'usage'
  | 'config'
  | 'auth'
  | 'not-found'
  | 'conflict'
  | 'rate-limit'
  | 'network'
  | 'upstream'
  | 'remote'
  | 'internal'

export const ERROR_KINDS: readonly ErrorKind[] = [
  'usage',
  'config',
  'auth',
  'not-found',
  'conflict',
  'rate-limit',
  'network',
  'upstream',
  'remote',
  'internal',
]

const EXIT_CODES: Record<ErrorKind, number> = {
  // The operator typed something unusable.
  usage: 2,
  // The credential is missing, wrong or not authorised.
  auth: 3,
  config: 1,
  'not-found': 1,
  conflict: 1,
  'rate-limit': 1,
  network: 1,
  upstream: 1,
  remote: 1,
  internal: 1,
}

export function exitCodeForKind(kind: ErrorKind): number {
  return EXIT_CODES[kind]
}

export function isErrorKind(value: string): value is ErrorKind {
  return (ERROR_KINDS as readonly string[]).includes(value)
}

export interface OpsErrorInit {
  /** HTTP status or remote exit code, when there was one. */
  status?: number
  hint?: string
  source?: string
  target?: string | null
  cause?: unknown
}

/** A failure the CLI can explain to the operator. */
export class OpsError extends Error {
  readonly kind: ErrorKind
  readonly status?: number
  readonly hint?: string
  source?: string
  target: string | null

  constructor(message: string, kind: ErrorKind = 'internal', init: OpsErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'OpsError'
    this.kind = kind
    this.status = init.status
    this.hint = init.hint
    this.source = init.source
    this.target = init.target ?? null
  }

  get exitCode(): number {
    return exitCodeForKind(this.kind)
  }

  /** Where the failure happened, for the envelope. Never overwrites an inner error's answer. */
  at(source?: string, target?: string | null): this {
    if (source !== undefined && this.source === undefined) this.source = source
    if (target !== undefined && target !== null && this.target === null) this.target = target
    return this
  }

  /** A copy carrying one more piece of the operator's context. */
  withHint(hint: string): OpsError {
    if (this.hint !== undefined) return this
    return new OpsError(this.message, this.kind, { status: this.status, hint, source: this.source, target: this.target })
  }
}

export function usageError(message: string, hint?: string): OpsError {
  return new OpsError(message, 'usage', { hint })
}

/**
 * Invalid configuration. Every problem is collected before the operator is
 * asked to act, so one edit can fix the whole file.
 */
export class ConfigError extends OpsError {
  readonly problems: string[]
  readonly path: string

  constructor(problems: string[], path: string) {
    super(numbered(problems), 'config', { source: 'config' })
    this.name = 'ConfigError'
    this.problems = problems
    this.path = path
  }
}

/** The numbered list the operator reads, in the order the file was validated. */
export function numbered(problems: string[]): string {
  return problems.map((problem, index) => `${index + 1}. ${problem}`).join('\n')
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Anything thrown becomes an OpsError, so there is one reporting path. */
export function asOpsError(error: unknown, kind: ErrorKind = 'internal'): OpsError {
  if (error instanceof OpsError) return error
  const wrapped = new OpsError(errorMessage(error), kind)
  if (error instanceof Error) wrapped.stack = error.stack
  return wrapped
}

/** How an HTTP status reads in the envelope's vocabulary. */
const KIND_BY_STATUS: Record<number, ErrorKind> = {
  400: 'usage',
  401: 'auth',
  403: 'auth',
  404: 'not-found',
  405: 'usage',
  409: 'conflict',
  415: 'usage',
  422: 'usage',
  429: 'rate-limit',
  500: 'upstream',
  501: 'upstream',
  502: 'upstream',
  503: 'upstream',
  504: 'upstream',
}

export function kindForStatus(status: number): ErrorKind {
  if (KIND_BY_STATUS[status] !== undefined) return KIND_BY_STATUS[status]!
  if (status >= 500) return 'upstream'
  if (status >= 400) return 'usage'
  return 'internal'
}

/** How a transport failure's `code` field reads in the envelope's vocabulary. */
const KIND_BY_SYSTEM_CODE: Record<string, ErrorKind> = {
  ENOENT: 'config',
  ECONNREFUSED: 'network',
  ECONNRESET: 'network',
  ECONNABORTED: 'network',
  ETIMEDOUT: 'network',
  EHOSTUNREACH: 'network',
  ENETUNREACH: 'network',
  ENOTFOUND: 'network',
  EAI_AGAIN: 'network',
  EPIPE: 'network',
  UND_ERR_CONNECT_TIMEOUT: 'network',
  UND_ERR_SOCKET: 'network',
  UND_ERR_HEADERS_TIMEOUT: 'network',
  UND_ERR_BODY_TIMEOUT: 'network',
}

/** Node/Bun `code` fields carry the useful half of a transport failure. */
export function kindForSystemCode(code: string | undefined): ErrorKind {
  return (code !== undefined && KIND_BY_SYSTEM_CODE[code]) || 'network'
}
