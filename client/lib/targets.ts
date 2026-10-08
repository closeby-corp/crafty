/**
 * The configuration file is the contract every command reads: one table per
 * target, discriminated by `kind`. Validation collects every problem in the
 * file before the operator is asked to fix anything.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configPathFromCli } from 'crafty'
import { ConfigError, OpsError } from 'crafty'
import { redactString, registerSecret } from 'crafty'
import { isTable } from './values.ts'
import configTemplateText from '../config.example.yml' with { type: 'text' }

export type Env = Record<string, string | undefined>

export type TargetKind =
  | 'opensearch'
  | 'kibana'
  | 'signoz'
  | 'prometheus'
  | 'grafana'
  | 'db'
  | 'bitbucket'
  | 'jira'

export const TARGET_KINDS: readonly TargetKind[] = [
  'bitbucket',
  'db',
  'grafana',
  'jira',
  'kibana',
  'opensearch',
  'prometheus',
  'signoz',
]

export function isTargetKind(value: string): value is TargetKind {
  return (TARGET_KINDS as readonly string[]).includes(value)
}

export type AuthKind = 'basic' | 'bearer' | 'none'

export interface HttpAuth {
  auth: AuthKind
  username?: string
  /**
   * The credential itself, written in this file: `password` for basic auth,
   * `token` for bearer. `secret` names a store key instead - one of the two.
   */
  password?: string
  token?: string
  /** Name of the entry in the secret store, when the value is not inline. */
  secret?: string
  headers?: Record<string, string>
  /**
   * Accept a certificate the machine does not trust (private CA, self-signed).
   * The documented internal Kibana needs this; the OpenSearch clusters below do
   * not, because their certificates verify here.
   */
  tls_insecure?: boolean
}

/**
 * The field names a source publishes, so a verb can compose the query the
 * catalog says works instead of guessing. `level` returns nothing on logback
 * indices; `log_level` is the field that has the level.
 */
export interface FieldCatalog {
  level_field?: string
  text_fields?: string[]
}

interface BaseTarget {
  name: string
}

export interface OpenSearchTarget extends BaseTarget, HttpAuth, FieldCatalog {
  kind: 'opensearch'
  base_url: string
  time_field: string
  default_index: string
}

export interface KibanaTarget extends BaseTarget, HttpAuth, FieldCatalog {
  kind: 'kibana'
  base_url: string
  default_index?: string
}

export interface PrometheusTarget extends BaseTarget, HttpAuth {
  kind: 'prometheus'
  base_url: string
}

export interface GrafanaTarget extends BaseTarget, HttpAuth {
  kind: 'grafana'
  base_url: string
}

export interface SignozTarget extends BaseTarget {
  kind: 'signoz'
  via: 'ssh'
  ssh_host: string
  container: string
  database: string
  logs_table: string
  time_column: string
}

/**
 * A set of databases DuckDB opens for one query. Each entry is a complete
 * `ATTACH` statement, used exactly as written - the operator says what to
 * attach, this CLI only insists that it is a single read-only attach.
 */
export interface DbTarget extends BaseTarget {
  kind: 'db'
  /** Database name -> connector string, exactly as the operator wrote it. */
  databases: Record<string, string>
}

/** A name a statement can address, and the string that reaches it. */
export interface DbDatabase {
  alias: string
  dsn: string
  /** The `db` target that declares it. */
  target: string
}

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/

/**
 * Names the group itself uses: `crafty db list` and `crafty db all …`. A database
 * cannot take one, so a subject is never ambiguous.
 */
const RESERVED_DATABASE_NAMES = ['all', 'list']

/**
 * Reads the databases of one `db` target. The connector string is the only way
 * in, and it is never echoed: a problem names the database, not the string.
 */
export function readDatabases(
  name: string,
  databases: Record<string, string>,
  problem: (message: string) => void,
): DbTarget | undefined {
  const names = Object.keys(databases)
  if (names.length === 0) {
    problem('a db target needs at least one database in `databases`')
    return undefined
  }
  let broken = false
  for (const alias of names) {
    if (RESERVED_DATABASE_NAMES.includes(alias)) {
      problem(`databases."${alias}": "${alias}" is reserved by \`crafty db\`; pick another name`)
      broken = true
      continue
    }
    if (!DATABASE_NAME.test(alias)) {
      problem(`databases."${alias}": "${alias}" is not a name a statement can use`)
      broken = true
      continue
    }
    const dsn = databases[alias] ?? ''
    if (!/^postgres(?:ql)?:\/\//i.test(dsn)) {
      problem(`databases.${alias}: needs a postgres:// connector string`)
      broken = true
    } else if (!dsn.includes('@')) {
      problem(`databases.${alias}: the connector string carries no user`)
      broken = true
    }
  }
  if (broken) return undefined
  return { name, kind: 'db', databases }
}

export interface BitbucketTarget extends BaseTarget, HttpAuth {
  kind: 'bitbucket'
  base_url: string
  workspace: string
}

export interface JiraTarget extends BaseTarget, HttpAuth {
  kind: 'jira'
  base_url: string
}

export type Target =
  | OpenSearchTarget
  | KibanaTarget
  | PrometheusTarget
  | GrafanaTarget
  | SignozTarget
  | DbTarget
  | BitbucketTarget
  | JiraTarget

/** Everything reached over HTTP with an optional Authorization header. */
export type HttpTarget =
  | OpenSearchTarget
  | KibanaTarget
  | PrometheusTarget
  | GrafanaTarget
  | BitbucketTarget
  | JiraTarget

export interface Settings {
  timeout_ms: number
  /** Budget for `crafty db`, where attaching one database costs a connection. */
  db_timeout_ms: number
  /** Budget for a bulk git operation (clone, commit, push). */
  git_timeout_ms: number
  max_rows: number
  data_dir: string
  git_author?: string
  default_targets: Record<string, string>
}

export const DEFAULT_SETTINGS: Settings = {
  timeout_ms: 15_000,
  db_timeout_ms: 60_000,
  git_timeout_ms: 600_000,
  max_rows: 200,
  data_dir: '~/.cache/ops-cli',
  default_targets: {},
}

export interface TargetFile {
  path: string
  settings: Settings
  ssh: { hosts: string[] }
  targets: Map<string, Target>
}

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** `$OPS_CONFIG`, then the XDG location, then `~/.config/ops-cli/config.yml`. */
export function defaultConfigPath(env: Env = process.env): string {
  const configured = env['OPS_CONFIG']
  if (configured !== undefined && configured !== '') return expandHome(configured)
  const xdg = env['XDG_CONFIG_HOME']
  if (xdg !== undefined && xdg !== '') return join(expandHome(xdg), 'ops-cli', 'config.yml')
  return join(homedir(), '.config', 'ops-cli', 'config.yml')
}

/** `--config` wins over the environment, so a one-off run needs no export. */
export function resolveConfigPath(env: Env = process.env, explicit?: string): string {
  if (explicit !== undefined && explicit !== '') return expandHome(explicit)
  return defaultConfigPath(env)
}

export function loadTargets(env: Env = process.env, explicitPath?: string): TargetFile {
  const path = resolveConfigPath(env, explicitPath ?? configPathFromCli())
  if (!existsSync(path)) {
    throw new ConfigError([`there is no configuration file at ${path}`, 'run `crafty config init` to write one'], path)
  }
  const text = readFileSync(path, 'utf8')
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch (error) {
    throw new ConfigError([`${path} is not valid YAML: ${(error as Error).message}`], path)
  }
  return validate(doc, path)
}

let cached: TargetFile | null = null

/** The file this process is reading, loaded once. */
export function loadConfig(): TargetFile {
  cached ??= loadTargets(process.env)
  return cached
}

export function resetConfigCache(): void {
  cached = null
}

export function targetsOfKind(file: TargetFile, kind: TargetKind): Target[] {
  return [...file.targets.values()].filter((target) => target.kind === kind)
}

/**
 * An explicit name, else the configured default for the kind, else the only
 * target of that kind. Anything ambiguous names the candidates.
 */
export function requireTarget(kind: TargetKind, name?: string): Target {
  return resolveTarget(loadConfig(), kind, name)
}

export function resolveTarget(file: TargetFile, kind: TargetKind, name?: string): Target {
  const candidates = targetsOfKind(file, kind)
  const wanted = name ?? file.settings.default_targets[kind]
  if (wanted !== undefined) {
    const found = file.targets.get(wanted)
    if (!found) {
      throw new OpsError(`no target named "${wanted}"`, 'config', {
        hint: `candidates of kind ${kind}: ${namesOf(candidates)}; define [targets.${wanted}] in ${file.path}`,
      })
    }
    if (found.kind !== kind) {
      throw new OpsError(`target "${wanted}" is a ${found.kind} target, not a ${kind} target`, 'config', {
        hint: `candidates of kind ${kind}: ${namesOf(candidates)}`,
      })
    }
    return found
  }

  if (candidates.length === 1) return candidates[0]!
  throw new OpsError(
    candidates.length === 0 ? `no ${kind} target is configured` : `--target is required: ${kind} targets are ${namesOf(candidates)}`,
    'config',
    {
      hint:
        candidates.length === 0
          ? `add [targets.<name>] with kind = "${kind}" to ${file.path}`
          : 'pass --target <name>, or set settings.default_targets',
    },
  )
}

function namesOf(targets: Target[]): string {
  return targets.length === 0 ? '(none)' : targets.map((target) => target.name).join(', ')
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const ALLOWED: Record<TargetKind, string[]> = {
  opensearch: [
    'kind',
    'base_url',
    'auth',
    'username',
    'password',
    'token',
    'secret',
    'headers',
    'time_field',
    'default_index',
    'level_field',
    'text_fields',
    'tls_insecure',
  ],
  kibana: [
    'kind',
    'base_url',
    'auth',
    'username',
    'password',
    'token',
    'secret',
    'headers',
    'default_index',
    'level_field',
    'text_fields',
    'tls_insecure',
  ],
  prometheus: ['kind', 'base_url', 'auth', 'username', 'password', 'token', 'secret', 'headers', 'tls_insecure'],
  grafana: ['kind', 'base_url', 'auth', 'username', 'password', 'token', 'secret', 'headers', 'tls_insecure'],
  signoz: ['kind', 'via', 'ssh_host', 'container', 'database', 'logs_table', 'time_column'],
  db: ['kind', 'databases'],
  bitbucket: ['kind', 'base_url', 'workspace', 'auth', 'username', 'password', 'token', 'secret', 'tls_insecure'],
  jira: ['kind', 'base_url', 'auth', 'username', 'password', 'token', 'secret', 'tls_insecure'],
}

const ALLOWED_SETTINGS = [
  'timeout_ms',
  'db_timeout_ms',
  'git_timeout_ms',
  'max_rows',
  'data_dir',
  'git_author',
  'default_targets',
]
const AUTH_KINDS: readonly string[] = ['basic', 'bearer', 'none']

/** Reads one table's fields, collecting a problem for each one that is wrong. */
class Reader {
  constructor(
    readonly where: string,
    readonly source: Record<string, unknown>,
    readonly problems: string[],
  ) {}

  problem(message: string): void {
    // A config value can be a credential, so nothing reaches the operator
    // unredacted: a db target's connector strings are registered before the
    // reader runs, and `redactString` replaces any that a message quotes.
    this.problems.push(redactString(`${this.where}: ${message}`))
  }

  string(key: string, fallback?: string): string | undefined {
    const value = this.source[key]
    if (value === undefined) return fallback
    if (typeof value !== 'string') {
      this.problem(`${key} must be a string, got ${JSON.stringify(value)}`)
      return fallback
    }
    return value
  }

  required(key: string, fallback?: string): string | undefined {
    const value = this.string(key, fallback)
    if (value === undefined) {
      this.problem(`${key} is required`)
      return fallback
    }
    if (value === '') {
      this.problem(`${key} must not be empty`)
      return fallback
    }
    return value
  }

  integer(key: string, fallback?: number, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined {
    const value = this.source[key]
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.problem(`${key} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`)
      return fallback
    }
    return value
  }

  boolean(key: string, fallback?: boolean): boolean | undefined {
    const value = this.source[key]
    if (value === undefined) return fallback
    if (typeof value !== 'boolean') {
      this.problem(`${key} must be true or false, got ${JSON.stringify(value)}`)
      return fallback
    }
    return value
  }

  strings(key: string): string[] | undefined {
    const value = this.source[key]
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      this.problem(`${key} must be an array of strings, got ${JSON.stringify(value)}`)
      return undefined
    }
    return value as string[]
  }

  table(key: string): Record<string, string> | undefined {
    const value = this.source[key]
    if (value === undefined) return undefined
    if (!isTable(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
      this.problem(`${key} must be a table of strings, got ${JSON.stringify(value)}`)
      return undefined
    }
    return value as Record<string, string>
  }
}

function validate(doc: unknown, path: string): TargetFile {
  const problems: string[] = []
  if (!isTable(doc)) {
    throw new ConfigError([`${path} must hold tables: [settings], [ssh] and one [targets.<name>] per target`], path)
  }

  const settings = readSettings(doc['settings'], problems)
  const ssh = readSsh(doc['ssh'], problems)
  const targets = readTargets(doc['targets'], problems)
  checkDefaults(settings, targets, problems)

  if (problems.length > 0) throw new ConfigError(problems, path)
  return { path, settings, ssh, targets }
}

function readSettings(raw: unknown, problems: string[]): Settings {
  if (raw === undefined) return { ...DEFAULT_SETTINGS }
  if (!isTable(raw)) {
    problems.push('settings: must be a table')
    return { ...DEFAULT_SETTINGS }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'default_targets' && !ALLOWED_SETTINGS.includes(key)) problems.push(`settings: unknown key "${key}"`)
  }
  const reader = new Reader('settings', raw, problems)
  const git_author = reader.string('git_author')
  return {
    timeout_ms: reader.integer('timeout_ms', DEFAULT_SETTINGS.timeout_ms) ?? DEFAULT_SETTINGS.timeout_ms,
    db_timeout_ms: reader.integer('db_timeout_ms', DEFAULT_SETTINGS.db_timeout_ms) ?? DEFAULT_SETTINGS.db_timeout_ms,
    git_timeout_ms: reader.integer('git_timeout_ms', DEFAULT_SETTINGS.git_timeout_ms) ?? DEFAULT_SETTINGS.git_timeout_ms,
    max_rows: reader.integer('max_rows', DEFAULT_SETTINGS.max_rows) ?? DEFAULT_SETTINGS.max_rows,
    data_dir: reader.string('data_dir', DEFAULT_SETTINGS.data_dir) ?? DEFAULT_SETTINGS.data_dir,
    ...(git_author === undefined ? {} : { git_author }),
    default_targets: readDefaults(raw['default_targets'], problems),
  }
}

function readDefaults(raw: unknown, problems: string[]): Record<string, string> {
  if (raw === undefined) return {}
  if (!isTable(raw)) {
    problems.push('settings.default_targets: must be a table of kind -> target name')
    return {}
  }
  const defaults: Record<string, string> = {}
  for (const [kind, value] of Object.entries(raw)) {
    if (!isTargetKind(kind)) {
      problems.push(`settings.default_targets: unknown kind "${kind}"; known kinds: ${TARGET_KINDS.join(', ')}`)
      continue
    }
    if (typeof value !== 'string') {
      problems.push(`settings.default_targets.${kind}: must be the name of a target, got ${JSON.stringify(value)}`)
      continue
    }
    defaults[kind] = value
  }
  return defaults
}

function readSsh(raw: unknown, problems: string[]): { hosts: string[] } {
  if (raw === undefined) return { hosts: [] }
  if (!isTable(raw)) {
    problems.push('ssh: must be a table')
    return { hosts: [] }
  }
  for (const key of Object.keys(raw)) if (key !== 'hosts') problems.push(`ssh: unknown key "${key}"`)
  return { hosts: new Reader('ssh', raw, problems).strings('hosts') ?? [] }
}

function readTargets(raw: unknown, problems: string[]): Map<string, Target> {
  const targets = new Map<string, Target>()
  if (raw === undefined) return targets
  if (!isTable(raw)) {
    problems.push('targets: must be a table, one [targets.<name>] per target')
    return targets
  }
  for (const [name, value] of Object.entries(raw)) {
    const target = readTarget(name, value, problems)
    if (target) targets.set(name, target)
  }
  return targets
}

function readTarget(name: string, raw: unknown, problems: string[]): Target | undefined {
  if (!isTable(raw)) {
    problems.push(`targets.${name}: must be a table`)
    return undefined
  }
  const kind = raw['kind']
  if (typeof kind !== 'string' || !isTargetKind(kind)) {
    problems.push(`targets.${name}: unknown kind ${JSON.stringify(kind)}; known kinds: ${TARGET_KINDS.join(', ')}`)
    return undefined
  }
  const reader = new Reader(`targets.${name}`, raw, problems)
  for (const key of Object.keys(raw)) {
    if (!ALLOWED[kind].includes(key)) problems.push(`targets.${name}: unknown key "${key}" for a ${kind} target`)
  }

  switch (kind) {
    case 'signoz':
      return readSignoz(name, reader)
    case 'db':
      registerDatabaseSecrets(raw['databases'])
      return readDb(name, reader)
    case 'opensearch': {
      const http = readHttp(reader)
      if (!http) return undefined
      return {
        ...http,
        ...readCatalog(reader),
        name,
        kind,
        time_field: reader.string('time_field', '@timestamp') ?? '@timestamp',
        default_index: reader.string('default_index', '*') ?? '*',
      }
    }
    case 'kibana': {
      const http = readHttp(reader)
      if (!http) return undefined
      const default_index = reader.string('default_index')
      return {
        ...http,
        ...readCatalog(reader),
        name,
        kind,
        ...(default_index === undefined ? {} : { default_index }),
      }
    }
    case 'bitbucket': {
      const http = readHttp(reader)
      const workspace = reader.required('workspace')
      if (!http || workspace === undefined) return undefined
      return { ...http, name, kind, workspace }
    }
    case 'prometheus':
    case 'grafana':
    case 'jira': {
      const http = readHttp(reader)
      if (!http) return undefined
      return { ...http, name, kind }
    }
  }
}

function readHttp(reader: Reader): (HttpAuth & { base_url: string }) | undefined {
  const base_url = reader.required('base_url')
  const auth = reader.string('auth', 'none') ?? 'none'
  if (!AUTH_KINDS.includes(auth)) {
    reader.problem(`auth must be one of ${AUTH_KINDS.join(', ')}, got "${auth}"`)
    return undefined
  }
  const username = reader.string('username')
  const password = reader.string('password')
  const token = reader.string('token')
  const secret = reader.string('secret')
  const headers = reader.table('headers')
  const tls_insecure = reader.boolean('tls_insecure')

  const written = [password, token, secret].filter((value) => value !== undefined && value !== '')
  if (written.length > 1) {
    reader.problem('give one credential: password (basic), token (bearer) or secret (a store key)')
    return undefined
  }
  if (auth === 'none' && (username !== undefined || written.length > 0)) {
    reader.problem('auth = "none" uses no credential; remove username/password/token/secret')
    return undefined
  }
  if (auth === 'basic' && (username === undefined || written.length === 0)) {
    reader.problem('auth = "basic" needs username and one of password or secret')
    return undefined
  }
  if (auth === 'bearer' && written.length === 0) {
    reader.problem('auth = "bearer" needs token (or secret, a store key)')
    return undefined
  }
  if (base_url === undefined) return undefined
  return {
    base_url: base_url.replace(/\/+$/, ''),
    auth: auth as AuthKind,
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    ...(token === undefined ? {} : { token }),
    ...(secret === undefined ? {} : { secret }),
    ...(headers === undefined ? {} : { headers }),
    ...(tls_insecure === undefined ? {} : { tls_insecure }),
  }
}

/** The field names a source publishes, when the file says so. */
function readCatalog(reader: Reader): FieldCatalog {
  const level_field = reader.string('level_field')
  const text_fields = reader.strings('text_fields')
  return {
    ...(level_field === undefined ? {} : { level_field }),
    ...(text_fields === undefined ? {} : { text_fields }),
  }
}

function readSignoz(name: string, reader: Reader): SignozTarget | undefined {
  const via = reader.string('via', 'ssh') ?? 'ssh'
  if (via !== 'ssh') {
    reader.problem('via must be "ssh"; the container is only reachable over ssh')
    return undefined
  }
  const ssh_host = reader.required('ssh_host')
  const container = reader.required('container')
  const database = reader.required('database')
  if (ssh_host === undefined || container === undefined || database === undefined) return undefined
  return {
    name,
    kind: 'signoz',
    via,
    ssh_host,
    container,
    database,
    logs_table: reader.string('logs_table', 'logs_v2') ?? 'logs_v2',
    time_column: reader.string('time_column', 'timestamp') ?? 'timestamp',
  }
}

/**
 * A connector string is a credential: register every one a db target carries
 * before anything can echo it, including a malformed value that a problem
 * message quotes back.
 */
function registerDatabaseSecrets(raw: unknown): void {
  if (typeof raw === 'string') {
    registerSecret(raw)
    return
  }
  if (isTable(raw)) {
    for (const value of Object.values(raw)) if (typeof value === 'string') registerSecret(value)
  }
}

function readDb(name: string, reader: Reader): DbTarget | undefined {
  const databases = reader.table('databases')
  if (databases === undefined) {
    reader.problem('a db target needs at least one database in `databases`')
    return undefined
  }
  return readDatabases(name, databases, (message) => reader.problem(message))
}

/** `pg-agg` -> `PG_AGG`, the suffix of the per-target environment overrides. */
export function envName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
}

function checkDefaults(settings: Settings, targets: Map<string, Target>, problems: string[]): void {
  for (const [kind, name] of Object.entries(settings.default_targets)) {
    const found = targets.get(name)
    if (!found) {
      problems.push(
        `settings.default_targets.${kind}: "${name}" is not a target; candidates of kind ${kind}: ${namesOf(
          [...targets.values()].filter((target) => target.kind === kind),
        )}`,
      )
      continue
    }
    if (found.kind !== kind) problems.push(`settings.default_targets.${kind}: "${name}" is a ${found.kind} target`)
  }
}

/** The commented configuration template owned by this client. */
export function configTemplate(): string {
  return configTemplateText
}
