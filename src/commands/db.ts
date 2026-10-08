/**
 * `crafty db`: read-only SQL over the PostgreSQL databases the config file lists.
 *
 * The database is the subject, so every verb reads `crafty db <database> <verb>`:
 *
 *   crafty db list                    the databases this machine can reach
 *   crafty db om query 'select 1'     a statement, run by that server
 *   crafty db om tables               what is in it
 *   crafty db all query '...'         one statement over every database
 *
 * `all` is only a name: it is refused as a database in the config file, so a
 * database can never shadow it.
 */
import { asOpsError, OpsError, usageError } from '../errors.ts'
import { assertReadOnly } from '../sql-guard.ts'
import { registerScriptSecrets, runDuckdb, sqlIdentifier, sqlLiteral } from '../duckdb.ts'
import { expandHome, loadConfig, type DbDatabase, type DbTarget, type Settings, type TargetFile } from '../targets.ts'
import { emitResult, intValue, option } from '../output.ts'
import type { Ctx } from '../output.ts'
import type { CommandModule, CommandNode } from '../command.ts'

/** The name that means "every configured database" instead of one. */
const ALL = 'all'

/** Every database the file configures, in name order. */
export function databasesOf(file: TargetFile = loadConfig(), name?: string): DbDatabase[] {
  const targets = [...file.targets.values()].filter((target): target is DbTarget => target.kind === 'db')
  const wanted = name === undefined ? targets : targets.filter((target) => target.name === name)
  const databases: DbDatabase[] = []
  for (const target of wanted) {
    for (const [alias, dsn] of Object.entries(target.databases)) {
      databases.push({ alias, dsn, target: target.name })
    }
  }
  return databases.sort((left, right) => left.alias.localeCompare(right.alias))
}

function namesOf(databases: DbDatabase[]): string {
  return databases.map((database) => database.alias).join(', ') || 'none'
}

/** The database the subject names, or a usage error that lists what exists. */
function subjectOf(subject: string, configured: DbDatabase[]): DbDatabase {
  const found = configured.find((database) => database.alias === subject)
  if (found === undefined) {
    throw usageError(`no database named "${subject}"`, `configured: ${namesOf(configured)} - \`crafty db list\` shows them`)
  }
  return found
}

/**
 * The connection, built here and never written by hand: read-only, so the layer
 * itself refuses a write, and the connector string registered before it can be
 * echoed.
 */
function connection(database: DbDatabase): string {
  registerScriptSecrets([database.dsn])
  return `ATTACH ${sqlLiteral(database.dsn)} AS ${sqlIdentifier(database.alias)} (TYPE postgres, READ_ONLY);`
}

/** One statement, handed to that server to run: the work happens there. */
async function onDatabase(
  database: DbDatabase,
  sql: string,
  settings: Settings,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const result = await runDuckdb(
    `${connection(database)}\nSELECT * FROM postgres_query(${sqlLiteral(database.alias)}, ${sqlLiteral(sql)});\n`,
    { timeoutMs: timeoutMs || settings.timeout_ms },
  )
  return result.rows
}

/** A database named as `<alias>.` somewhere in the statement. */
function referenced(alias: string, sql: string): boolean {
  return sql.includes(`${alias}.`)
}

/** What each verb asks Postgres for. `list` is not here: it is not a query. */
/** The server's own schemas are the same everywhere: a listing leaves them out. */
const NOT_SYSTEM = (column: string): string =>
  `and ${column} not in ('pg_catalog', 'information_schema') and ${column} not like 'pg\\_%'`

const LISTINGS: Record<string, string> = {
  tables:
    "select table_schema as schema, table_name as name from information_schema.tables " +
    `where table_type = 'BASE TABLE' ${NOT_SYSTEM('table_schema')} order by 1, 2`,
  views:
    'select table_schema as schema, table_name as name from information_schema.views ' +
    `where 1 = 1 ${NOT_SYSTEM('table_schema')} ` +
    'union all select schemaname, matviewname from pg_matviews ' +
    `where 1 = 1 ${NOT_SYSTEM('schemaname')} order by 1, 2`,
  triggers:
    'select trigger_schema as schema, event_object_table as "table", trigger_name as name, ' +
    'action_timing as timing, event_manipulation as event from information_schema.triggers ' +
    `where 1 = 1 ${NOT_SYSTEM('trigger_schema')} order by 1, 2, 3`,
  schemas:
    "select schema_name as name from information_schema.schemata " +
    "where schema_name <> 'information_schema' and schema_name not like 'pg\\_%' order by 1",
  databases: 'select datname as name from pg_database order by 1',
}

/** `settings.db_timeout_ms` for the statement plus a slot per database touched. */
function timeoutFor(ctx: Ctx, settings: Settings, databases: number): number {
  const raw = option(ctx.values, 'timeout')
  if (raw === undefined) return settings.db_timeout_ms + settings.timeout_ms * databases
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageError('--timeout must be a positive number of seconds')
  return Math.round(seconds * 1_000)
}

/** Words that mean the operator typed a statement where a table was expected. */
const SQL_WORDS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'from',
  'where',
  'with',
  'values',
  'table',
  'show',
  'explain',
  'describe',
  'pragma',
  'call',
  'set',
  'begin',
  'commit',
])

/** A table as Postgres spells one: bare, or schema-qualified. */
function tableParts(raw: string | undefined, usage: string): { table: string; schema?: string } {
  if (raw === undefined || raw === '') throw usageError('a table name is required', usage)
  if (!/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(raw)) {
    throw usageError(`"${raw}" is not a table name`, usage)
  }
  const [first, second] = raw.split('.')
  return second === undefined ? { table: first! } : { schema: first, table: second }
}

/** A table name out of the argument, the way `describe` wants it. */
function tableName(raw: string | undefined): { table: string; schema?: string } {
  return tableParts(raw, 'as in `crafty db om describe orders` or `crafty db om describe public.orders`')
}

/**
 * What `query` was given: a whole statement in one argument, or a table and a
 * WHERE clause in two. Nothing is inferred: a table on its own, or three
 * arguments, is refused with both forms spelled out.
 */
export type QueryArguments =
  | { kind: 'statement'; statement: string }
  | { kind: 'table'; table: string; clause: string }

async function queryArguments(ctx: Ctx, args: string[]): Promise<QueryArguments> {
  const file = option(ctx.values, 'file')
  if (file !== undefined && file !== '') {
    if (args.length > 0) throw usageError('give a statement or --file, not both')
    const path = expandHome(file)
    const text = await Bun.file(path).text().catch(() => '')
    if (text === '') throw usageError(`no such file, or it is empty: ${path}`, '--file wants a path to a .sql file')
    return { kind: 'statement', statement: text }
  }
  const forms = "one argument is a whole statement: `crafty db om query 'select count(*) from orders'`; two are a table and a WHERE clause: `crafty db om query orders 'status = 1'`"
  if (args.length === 0) throw usageError('the statement is required', forms)
  if (args.length === 1) {
    const only = args[0]!.trim()
    // No SQL statement is a bare name, so this is a table without its clause.
    if (/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(only) && !SQL_WORDS.has(only.toLowerCase())) {
      throw usageError(`"${only}" is a table, not a statement`, forms)
    }
    return { kind: 'statement', statement: args[0]! }
  }
  if (args.length === 2) {
    const raw = args[0]!
    const parts = tableParts(raw, forms)
    if (SQL_WORDS.has(raw.toLowerCase())) {
      throw usageError(`"${raw}" is not a table name`, `a whole statement is one argument: \`crafty db om query 'select 1'\``)
    }
    return {
      kind: 'table',
      table: parts.schema === undefined ? parts.table : `${parts.schema}.${parts.table}`,
      clause: args[1]!,
    }
  }
  throw usageError(`\`crafty db ... query\` was given ${args.length} arguments`, forms)
}

/** `select * from <table> where <clause>`, as the operator wrote the clause. */
function tableStatement(table: string, clause: string): string {
  return `select * from ${table} where ${clause}`
}

/** One statement over one database, or over every one with a qualified name. */
async function runQuery(ctx: Ctx, file: TargetFile, subject: string, args: string[]): Promise<number> {
  const settings = file.settings
  const configured = databasesOf(file)
  const given = await queryArguments(ctx, args)
  if (given.kind === 'table' && subject === ALL) {
    const [schemaOrDatabase, rest] = given.table.split('.')
    const suggestion =
      rest === undefined
        ? `crafty db <database> query ${given.table} '${given.clause}'`
        : `crafty db ${schemaOrDatabase} query ${rest} '${given.clause}'`
    throw usageError('a table shorthand asks one database', `name it: \`${suggestion}\``)
  }
  const statement = given.kind === 'statement' ? given.statement : tableStatement(given.table, given.clause)
  if (/\bpostgres_query\s*\(/i.test(statement)) {
    throw usageError(
      '"postgres_query" is not a function of a configured database',
      'crafty db runs Postgres SQL: name the database as `crafty db <name> query`, or a table as <name>.<schema>.<table>',
    )
  }
  const limit = intValue(ctx, 'limit', settings.max_rows)

  if (subject !== ALL) {
    const database = subjectOf(subject, configured)
    assertReadOnly(statement, 'postgres')
    const rows = await onDatabase(database, statement, settings, timeoutFor(ctx, settings, 1))
    emitResult(ctx, rows.slice(0, limit), {
      truncated: rows.length > limit,
      databases: [database.alias],
      database: database.alias,
    })
    return 0
  }

  assertReadOnly(statement, 'duckdb')
  const touched = configured.filter((database) => referenced(database.alias, statement))
  const prepared = touched.map(connection)
  const hint =
    touched.length === 0 && configured.length > 0
      ? `name the database in the statement (\`<name>.public.<table>\`); configured: ${namesOf(configured)}`
      : undefined
  let rows: Record<string, unknown>[]
  try {
    const result = await runDuckdb(`${prepared.map((line) => `${line}\n`).join('')}${statement.replace(/;\s*$/, '')};\n`, {
      timeoutMs: timeoutFor(ctx, settings, prepared.length),
    })
    rows = result.rows
  } catch (error) {
    const ops = asOpsError(error)
    if (hint === undefined) throw ops
    throw new OpsError(ops.message, ops.kind, { status: ops.status, hint })
  }
  emitResult(ctx, rows.slice(0, limit), {
    truncated: rows.length > limit,
    databases: touched.map((database) => database.alias),
  })
  return 0
}

/** One listing verb, for one database or for every one. */
async function runListing(ctx: Ctx, file: TargetFile, subject: string, verb: string): Promise<number> {
  const sql = LISTINGS[verb]!
  const settings = file.settings
  const pattern = option(ctx.values, 'pattern')?.toLowerCase()
  const keep = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    pattern === undefined ? rows : rows.filter((row) => String(row['name'] ?? '').toLowerCase().includes(pattern))

  if (subject !== ALL) {
    const database = subjectOf(subject, databasesOf(file))
    const rows = await onDatabase(database, sql, settings, timeoutFor(ctx, settings, 1))
    emitResult(ctx, keep(rows).map((row) => ({ database: database.alias, ...row })), {
      truncated: false,
      database: database.alias,
    })
    return 0
  }

  const configured = databasesOf(file)
  const rows: Record<string, unknown>[] = []
  const failed: Array<{ database: string; problem: string }> = []
  for (const database of configured) {
    try {
      for (const row of await onDatabase(database, sql, settings, timeoutFor(ctx, settings, 1))) {
        rows.push({ database: database.alias, ...row })
      }
    } catch (error) {
      failed.push({ database: database.alias, problem: error instanceof Error ? error.message : String(error) })
    }
  }
  emitResult(ctx, keep(rows), {
    truncated: false,
    databases: configured.map((database) => database.alias),
    ...(failed.length === 0 ? {} : { failed }),
  })
  return 0
}

/** Columns of one table, as Postgres reports them. */
async function runDescribe(ctx: Ctx, file: TargetFile, subject: string, args: string[]): Promise<number> {
  const { table, schema } = tableName(args[0])
  const database =
    subject === ALL
      ? (() => {
          throw usageError('describe asks one database', '`crafty db <name> describe <table>`, or `crafty db list` first')
        })()
      : subjectOf(subject, databasesOf(file))
  const sql = [
    'select column_name as column, data_type as type, is_nullable as nullable, column_default as "default"',
    'from information_schema.columns',
    `where table_name = ${sqlLiteral(table)}`,
    ...(schema === undefined ? [] : [`and table_schema = ${sqlLiteral(schema)}`]),
    'order by ordinal_position',
  ].join(' ')
  const rows = await onDatabase(database, sql, file.settings, timeoutFor(ctx, file.settings, 1))
  if (rows.length === 0) {
    const pattern = schema === undefined ? table : `${schema}.${table}`
    throw new OpsError(`no table named "${pattern}" in ${database.alias}`, 'not-found', {
      hint: `\`crafty db ${database.alias} tables --pattern ${table}\` lists what is there`,
    })
  }
  emitResult(ctx, rows, { truncated: false, database: database.alias })
  return 0
}

/** The identity one server reports. */
async function runWhoami(ctx: Ctx, file: TargetFile, subject: string): Promise<number> {
  if (subject === ALL) throw usageError('whoami asks one database', 'as in `crafty db om whoami`')
  const database = subjectOf(subject, databasesOf(file))
  const rows = await onDatabase(
    database,
    'select current_user as username, current_database() as database, version() as version',
    file.settings,
    timeoutFor(ctx, file.settings, 1),
  )
  emitResult(ctx, rows, { truncated: false, database: database.alias })
  return 0
}

/** `host:port` and the database name out of a connector string, for `list`. */
function addressOf(dsn: string): { host?: string; database?: string } {
  const match = /^postgres(?:ql)?:\/\/(?:[^@/'\s]*@)?([^/:?'\s]+)(?::(\d+))?\/([^?'\s]*)/i.exec(dsn)
  if (match === null) return {}
  return {
    ...(match[1] === undefined ? {} : { host: match[2] === undefined ? match[1] : `${match[1]}:${match[2]}` }),
    ...(match[3] === undefined || match[3] === '' ? {} : { database: match[3] }),
  }
}

/** Does one database answer? What `list` prints per database. */
async function answers(database: DbDatabase, settings: Settings): Promise<string | undefined> {
  try {
    const rows = await runDuckdb(
      `${connection(database)}\nSELECT * FROM postgres_query(${sqlLiteral(database.alias)}, 'select 1 as one');\n`,
      { timeoutMs: settings.timeout_ms },
    )
    if (rows.rows.length !== 1) return `select 1 answered with ${rows.rows.length} rows`
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** `ops doctor` asks this: do the target's databases answer? */
export async function probeDb(target: DbTarget, settings: Settings): Promise<{ ok: boolean; detail: string }> {
  const databases = databasesOf(loadConfig(), target.name)
  const problems: string[] = []
  let answered = 0
  for (const database of databases) {
    const problem = await answers(database, settings)
    if (problem === undefined) answered += 1
    else problems.push(`${database.alias}: ${problem}`)
  }
  if (problems.length === 0) return { ok: true, detail: `${answered} database(s) answered select 1` }
  return { ok: false, detail: `${answered}/${databases.length} answered; ${problems.slice(0, 2).join('; ')}` }
}

/** Every database this machine can read, and whether each one answers. */
async function runList(ctx: Ctx, file: TargetFile): Promise<number> {
  const rows: Record<string, unknown>[] = []
  for (const database of databasesOf(file)) {
    const problem = await answers(database, file.settings)
    rows.push({
      name: database.alias,
      target: database.target,
      ...addressOf(database.dsn),
      status: problem === undefined ? 'ok' : 'error',
      ...(problem === undefined ? {} : { problem }),
    })
  }
  emitResult(ctx, rows, { columns: ['name', 'target', 'host', 'database', 'status', 'problem'], truncated: false })
  return 0
}

const databaseCommands: Record<string, CommandNode> = {
  query: {
    summary: 'One statement, or a table and a WHERE clause',
    run: async (ctx) => {
      const file = ctx.state.dbConfig as TargetFile
      return await runQuery(ctx, file, ctx.params.database!, [...ctx.positionals, ...ctx.tail])
    },
  },
  describe: {
    summary: 'Columns of one table',
    run: async (ctx) => await runDescribe(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!, ctx.positionals),
  },
  tables: {
    summary: 'Tables a statement can read',
    run: async (ctx) => await runListing(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!, 'tables'),
  },
  views: {
    summary: 'Views, including materialised ones',
    run: async (ctx) => await runListing(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!, 'views'),
  },
  triggers: {
    summary: 'Triggers, with the table and the event they fire on',
    run: async (ctx) => await runListing(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!, 'triggers'),
  },
  schemas: {
    summary: 'Schemas that server holds',
    run: async (ctx) => await runListing(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!, 'schemas'),
  },
  databases: {
    summary: 'Databases that server holds',
    run: async (ctx) => await runListing(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!, 'databases'),
  },
  whoami: {
    summary: 'The account and server the database answers as',
    run: async (ctx) => await runWhoami(ctx, ctx.state.dbConfig as TargetFile, ctx.params.database!),
  },
}

const USAGE = [
  'crafty db list',
  'crafty db <database> <verb> [argument] [options]',
  '',
  'Read-only Postgres SQL over the databases the config file lists, one at a time',
  'or all at once. The database comes first, so every verb reads as a sentence:',
  '',
  '  crafty db list                              the databases this machine can reach',
  "  crafty db om query 'select count(*) from orders'",
  "  crafty db om query orders 'status = 1'      select * from orders where status = 1",
  '  crafty db om describe orders                columns of one table',
  '  crafty db om tables                         also: views, triggers, schemas, databases',
  '  crafty db om whoami                         who this is, on that server',
  '  crafty db all tables                        every configured database, one row set',
  '  crafty db all query "select ... from om.public.orders o',
  '                                join sd.public.orders s on s.id = o.id"',
  '',
  '`all` is the one name that is not a database: a statement over `all` may join',
  'across databases by naming each table as `<database>.<schema>.<table>`. A',
  'statement sent to one database is executed by that server, which is the fast',
  'path; a statement over `all` is read row by row, so filter it well.',
  '',
  'Read-only is enforced twice: the guard refuses anything that is not a single',
  'read, and every connection is opened read-only. Rows are capped at',
  'settings.max_rows (`--limit`), and a connector string is never printed.',
  '',
  'Verbs:',
  ...Object.entries(databaseCommands).map(([name, node]) => `  ${name.padEnd(10)} ${node.summary}`),
  '',
  'Options:',
  '  --file <path>     Read a whole statement from a .sql file, for `query`',
  '  --pattern <text>  Only names containing this text, for a listing',
  '  --limit <n>       Rows to print (default settings.max_rows)',
  '  --timeout <s>     Timeout in seconds (default settings.db_timeout_ms)',
  '  --json            Print the envelope instead of a table',
  '  --format <kind>   json, table, csv or plain; table and csv want row sets',
  '  -v, --verbose     Trace what each verb asks for',
  '  -c, --config      Read settings from this file instead of the default',
  '  -h, --help        Show this message',
]

const dbCommand = {
  name: 'db',
  summary: 'Read-only SQL over the PostgreSQL databases the config file lists',
  usage: USAGE,
  source: 'db',
  options: [
    { name: 'file', type: 'string' },
    { name: 'pattern', type: 'string' },
    { name: 'limit', type: 'string' },
    { name: 'timeout', type: 'string' },
  ],
  init(ctx) {
    ctx.state.dbConfig = loadConfig()
  },
  commands: {
    list: {
      summary: 'Every configured database and whether it answers',
      run: async (ctx) => {
        if (ctx.positionals.length > 0) throw usageError('list takes no arguments', '`crafty db list` lists every configured database')
        return await runList(ctx, ctx.state.dbConfig as TargetFile)
      },
    },
    all: {
      summary: 'Run a verb over every configured database',
      init(ctx) {
        ctx.params.database = ALL
      },
      commands: databaseCommands,
    },
    ':database': {
      summary: 'Run a verb over one configured database',
      init(ctx) {
        const file = ctx.state.dbConfig as TargetFile
        subjectOf(ctx.params.database!, databasesOf(file))
      },
      commands: databaseCommands,
    },
  },
} satisfies CommandModule

export default dbCommand
