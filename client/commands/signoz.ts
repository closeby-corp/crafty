/**
 * `crafty signoz`: the logs ClickHouse behind SigNoz, reached through the ssh
 * transport. The container is not exposed, so every statement is piped over
 * stdin into `clickhouse-client` rather than passed as `--query` - that path
 * crosses two shells and mangles identifiers like `resources_string['host.name']`.
 */
import { OpsError, usageError } from 'crafty'
import { sshRun } from '../lib/ssh.ts'
import { expandHome, loadConfig, requireTarget } from '../lib/targets.ts'
import type { SignozTarget } from '../lib/targets.ts'
import { isTable } from '../lib/values.ts'
import { emitResult, intValue, option } from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { assertReadOnly } from '../lib/sql-guard.ts'
import { parseSince } from '../lib/time.ts'

export type LogsSqlOptions = {
  /** Lower edge of the window, in epoch milliseconds. */
  sinceMs: number
  /** Upper edge, normally now. */
  nowMs: number
  severity?: string[]
  grep?: string
  limit: number
}

/**
 * A ClickHouse string literal: backslash and quote are the two characters the
 * server's own parser treats specially.
 */
function quoteSql(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

/** The identifier subset of SQL that can be interpolated without quoting. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) throw usageError(`${what} "${value}" is not a bare SQL identifier`)
  return value
}

/**
 * The `signoz logs` statement, built exactly as the plan specifies: the window
 * is nanosecond arithmetic done server-side against `now64(9)`, so a slow ssh
 * hop cannot shift it.
 */
export function buildLogsSql(table: string, timeColumn: string, options: LogsSqlOptions): string {
  const windowSeconds = Math.max(1, Math.round((options.nowMs - options.sinceMs) / 1_000))
  const lines = [
    `SELECT fromUnixTimestamp64Nano(${timeColumn}) AS ts, severity_text, resources_string['host.name'] AS host, body`,
    `FROM ${table}`,
    `WHERE ${timeColumn} >= toUInt64(toUnixTimestamp64Nano(now64(9)) - ${windowSeconds * 1_000_000_000})`,
  ]
  if (options.severity !== undefined && options.severity.length > 0) {
    lines.push(`  AND severity_text IN (${options.severity.map(quoteSql).join(', ')})`)
  }
  if (options.grep !== undefined && options.grep !== '') {
    lines.push(`  AND positionCaseInsensitive(body, ${quoteSql(options.grep)}) > 0`)
  }
  lines.push(`ORDER BY ${timeColumn} DESC`, `LIMIT ${options.limit}`)
  return lines.join('\n')
}

/**
 * `clickhouse-client --format JSON` answers `{ meta, data, rows, statistics }`;
 * the caller wants the `data` array and nothing else.
 */
export function parseClickHouseReply(stdout: string): Record<string, unknown>[] {
  const text = stdout.trim()
  if (text === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new OpsError(`clickhouse-client did not answer JSON: ${(error as Error).message}`, 'upstream', {
      hint: 'the container may have printed a warning or an error before the result',
    })
  }
  if (!isTable(parsed)) throw new OpsError('clickhouse-client answered something other than a JSON object', 'upstream')
  const data = parsed['data']
  if (!Array.isArray(data)) {
    throw new OpsError('the clickhouse-client reply has no data array', 'upstream', {
      hint: 'expected { meta, data, rows, statistics }',
    })
  }
  return data.map((row) => (isTable(row) ? row : { value: row }))
}

/** One container, one database; the flags are the same everywhere. */
function signozTarget(ctx: Ctx): SignozTarget {
  const target = requireTarget('signoz', option(ctx.values, 'target'))
  if (target.kind !== 'signoz') {
    throw new OpsError(`target "${target.name}" is not a signoz target`, 'config')
  }
  ctx.target = target.name
  return target
}

/** The remote command: ClickHouse talks JSON, on the target's database. */
export function clickhouseArgv(target: SignozTarget): string[] {
  return [
    'docker',
    'exec',
    '-i',
    target.container,
    'clickhouse-client',
    '--format',
    'JSON',
    '--database',
    target.database,
  ]
}

/**
 * Sends one statement and unwraps the reply. The guard runs here, so no verb
 * can forget it, and it is the last thing before stdin is written. Exported
 * because `crafty doctor` probes a target through exactly this path.
 */
export async function runSql(target: SignozTarget, sql: string): Promise<Record<string, unknown>[]> {
  assertReadOnly(sql, 'clickhouse')
  const settings = loadConfig().settings
  const result = await sshRun(target.ssh_host, clickhouseArgv(target), {
    stdin: sql,
    timeoutMs: settings.timeout_ms,
  })
  return parseClickHouseReply(result.stdout)
}

/** Rows beyond `settings.max_rows` are dropped here, never by rewriting SQL. */
function capped(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; truncated: boolean } {
  const max = loadConfig().settings.max_rows
  return rows.length > max ? { rows: rows.slice(0, max), truncated: true } : { rows, truncated: false }
}

function emitRows(ctx: Ctx, rows: Record<string, unknown>[], columns?: string[]): number {
  const { rows: kept, truncated } = capped(rows)
  emitResult(ctx, kept, { truncated, ...(columns === undefined ? {} : { columns }) })
  return 0
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

const targetOption = { name: 'target', type: 'string' as const }

const databasesVerb: CommandNode = {
  summary: 'Databases on the ClickHouse behind SigNoz',
  usage: [
    'crafty signoz databases [options]',
    '',
    'Lists the databases the ClickHouse container serves. The statement runs',
    'inside the container over ssh, so no ClickHouse credentials are needed.',
    '',
    'Options:',
    '  --target <name>  SigNoz target from the config file',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [targetOption],
  run: async (ctx) => {
    const target = signozTarget(ctx)
    const rows = await runSql(target, 'SHOW DATABASES')
    return emitRows(ctx, rows)
  },
}

const tablesVerb: CommandNode = {
  summary: 'Tables of one database',
  usage: [
    'crafty signoz tables [options]',
    '',
    'Lists the tables of `--database`, or of the database the target declares.',
    '',
    'Options:',
    '  --database <name>  Database to list (default the target\'s)',
    '  --target <name>    SigNoz target from the config file',
    '  --json             Print the envelope',
    '  -h, --help         Show this message',
  ],
  options: [{ name: 'database', type: 'string' }, targetOption],
  run: async (ctx) => {
    const target = signozTarget(ctx)
    const database = identifier(option(ctx.values, 'database') ?? target.database, '--database')
    const rows = await runSql(target, `SHOW TABLES FROM ${database}`)
    return emitRows(ctx, rows)
  },
}

const describeVerb: CommandNode = {
  summary: 'Columns of one table',
  usage: [
    'crafty signoz describe <table> [options]',
    '',
    'Prints one row per column of `<table>`, qualified by the target\'s database.',
    '',
    'Options:',
    '  --target <name>  SigNoz target from the config file',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [targetOption],
  run: async (ctx) => {
    const target = signozTarget(ctx)
    const table = ctx.positionals[0]
    if (table === undefined) throw usageError('the table name is required', 'run `crafty signoz tables` to list them')
    const database = identifier(target.database, 'the database')
    const rows = await runSql(target, `DESCRIBE TABLE ${database}.${identifier(table, 'the table')}`)
    return emitRows(ctx, rows)
  },
}

const queryVerb: CommandNode = {
  summary: 'Run one read-only statement',
  usage: [
    'crafty signoz query (--sql SQL | --file PATH) [options]',
    '',
    'Runs one read-only statement against the logs database, with the SQL on stdin.',
    'Anything that is not a single SELECT/SHOW/DESCRIBE/EXPLAIN is refused before',
    'it reaches the server, so this verb cannot write.',
    '',
    'Options:',
    '  --sql <sql>      The statement to run',
    '  --file <path>    Read the statement from this file instead',
    '  --target <name>  SigNoz target from the config file',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'sql', type: 'string' }, { name: 'file', type: 'string' }, targetOption],
  run: async (ctx) => {
    const target = signozTarget(ctx)
    const inline = option(ctx.values, 'sql')
    const path = option(ctx.values, 'file')
    if ((inline === undefined) === (path === undefined)) {
      throw usageError(
        inline === undefined ? 'one of --sql or --file is required' : 'give only one of --sql or --file',
        'for a quick check: --sql "SELECT count() FROM signoz_logs.logs_v2"',
      )
    }
    let sql = inline
    if (sql === undefined) {
      try {
        sql = await Bun.file(expandHome(path!)).text()
      } catch (error) {
        throw usageError(`cannot read ${path}: ${(error as Error).message}`)
      }
    }
    const rows = await runSql(target, sql)
    return emitRows(ctx, rows)
  },
}

const logsVerb: CommandNode = {
  summary: 'Logs from the SigNoz table, newest first',
  usage: [
    'crafty signoz logs [options]',
    '',
    'Reads the target\'s logs table in a time window. --grep is a case-insensitive',
    'substring match done by ClickHouse, not a regular expression; --severity may be',
    'repeated or comma-separated.',
    '',
    'Options:',
    '  --since <when>     Start of the window (default 1h)',
    '  --limit <n>        Rows to fetch (default 200)',
    '  --grep <text>      Keep only bodies containing this text',
    '  --severity <name>  Only this severity, repeatable (e.g. ERROR)',
    '  --target <name>    SigNoz target from the config file',
    '  --json             Print the envelope',
    '  -h, --help         Show this message',
  ],
  options: [
    { name: 'since', type: 'string' },
    { name: 'limit', type: 'string' },
    { name: 'grep', type: 'string' },
    targetOption,
  ],
  repeatable: ['severity'],
  run: async (ctx) => {
    const target = signozTarget(ctx)
    const since = parseSince(option(ctx.values, 'since') ?? '1h')
    const limit = intValue(ctx, 'limit', 200, 1, 100_000)
    const severity = (ctx.repeat['severity'] ?? [])
      .flatMap((entry) => entry.split(','))
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    const table = `${identifier(target.database, 'the database')}.${identifier(target.logs_table, 'logs_table')}`
    const timeColumn = identifier(target.time_column, 'time_column')
    const sql = buildLogsSql(table, timeColumn, {
      sinceMs: since.ms,
      nowMs: Date.now(),
      ...(severity.length === 0 ? {} : { severity }),
      ...(option(ctx.values, 'grep') === undefined ? {} : { grep: option(ctx.values, 'grep') }),
      limit,
    })
    const rows = await runSql(target, sql)
    return emitRows(ctx, rows, ['ts', 'severity_text', 'host', 'body'])
  },
}

export default {
  name: 'signoz',
  summary: 'Read the logs ClickHouse behind SigNoz over ssh',
  source: 'signoz',
  commands: {
    databases: databasesVerb,
    tables: tablesVerb,
    describe: describeVerb,
    query: queryVerb,
    logs: logsVerb,
  },
} satisfies CommandModule
