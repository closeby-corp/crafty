import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import dbCommand, { databasesOf } from '../commands/db.ts'
import { resetConfigCache, type DbDatabase } from '../lib/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { installFakeDuckdb, type FakeDuckdb } from './helpers/fake-duckdb.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-db-'))
const CONFIG = join(scratch, 'config.yml')
let duck: FakeDuckdb

/** Two targets, four databases: the subject of a verb is always named. */
const CONFIG_TEXT = `
settings:
  max_rows: 200
  timeout_ms: 5000
targets:
  apps:
    kind: db
    databases:
      sd: postgres://smartdispatcher:sd-password@192.168.86.199:5432/smartdispatcher
      om: postgres://user_sd_order_manager_admin:om-password@uq-application-database.production.uq-systems.net:5432/sd_order_manager
  single:
    kind: db
    databases:
      agg: postgres://reader:one-password@192.168.86.141:5432/aggregator_gateway
`

writeFileSync(CONFIG, CONFIG_TEXT)

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

function metaOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['meta'] as Record<string, unknown>
}

beforeAll(() => {
  duck = installFakeDuckdb()
})

afterAll(() => {
  duck.restore()
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  process.env['OPS_CONFIG'] = CONFIG
  resetConfigCache()
  duck.reset()
  duck.reply('[]')
})

afterEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

describe('the databases a target lists', () => {
  const all = (): DbDatabase[] => databasesOf()

  test('every db target contributes its names, in order', () => {
    expect(all().map((database) => [database.alias, database.target])).toEqual([
      ['agg', 'single'],
      ['om', 'apps'],
      ['sd', 'apps'],
    ])
  })

  test('a target can be asked for its own databases', () => {
    expect(databasesOf(undefined, 'single').map((database) => database.alias)).toEqual(['agg'])
  })
})

describe('ops db list', () => {
  test('one row per configured database, with where it points and whether it answers', async () => {
    duck.reply('[{"one":1}]')
    const capture = await runCaptured(dbCommand, ['list', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([
      { name: 'agg', target: 'single', host: '192.168.86.141:5432', database: 'aggregator_gateway', status: 'ok' },
      {
        name: 'om',
        target: 'apps',
        host: 'uq-application-database.production.uq-systems.net:5432',
        database: 'sd_order_manager',
        status: 'ok',
      },
      { name: 'sd', target: 'apps', host: '192.168.86.199:5432', database: 'smartdispatcher', status: 'ok' },
    ])
    expect(capture.stdout).not.toContain('om-password')
  })

  test('a database that refuses the credential reports the reason, redacted', async () => {
    duck.reply(
      '',
      1,
      'IO Error: Unable to connect to Postgres at "postgres://smartdispatcher:sd-password@192.168.86.199:5432/smartdispatcher": password authentication failed\n',
    )
    const capture = await runCaptured(dbCommand, ['list', '--json'])
    expect(capture.code).toBe(0)
    const rows = envelope(capture)['data'] as Record<string, unknown>[]
    expect(rows.every((row) => row['status'] === 'error')).toBe(true)
    expect(String(rows[0]?.['problem'])).toContain('password authentication failed')
    expect(capture.stdout).not.toContain('sd-password')
    expect(capture.stdout).not.toContain('om-password')
  })

  test('list refuses extra positional arguments', async () => {
    const capture = await runCaptured(dbCommand, ['list', 'tables', '--json'])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(duck.argv()).toHaveLength(0)
  })
})

describe('ops db <database> query', () => {
  test('the statement is an argument, and that server runs it', async () => {
    duck.reply('[{"current_user":"user_sd_order_manager_admin"}]')
    const capture = await runCaptured(dbCommand, ['om', 'query', 'select current_user', '--json'])
    expect(capture.code).toBe(0)
    const script = duck.lastScript()
    expect(script).toContain("ATTACH 'postgres://user_sd_order_manager_admin:om-password@")
    expect(script).toContain('READ_ONLY')
    expect(script).toContain("postgres_query('om', 'select current_user')")
    expect(script).not.toContain('sd-password')
    expect(envelope(capture)['data']).toEqual([{ current_user: 'user_sd_order_manager_admin' }])
    expect(metaOf(capture)).toMatchObject({ database: 'om', databases: ['om'], truncated: false })
    expect(metaOf(capture)['engine']).toBeUndefined()
  })

  test('a table and a WHERE clause build the statement', async () => {
    duck.reply('[{"key":1}]')
    const capture = await runCaptured(dbCommand, ['sd', 'query', 'dispatch_orders', 'key > 0', '--json'])
    expect(capture.code).toBe(0)
    expect(duck.lastScript()).toContain("postgres_query('sd', 'select * from dispatch_orders where key > 0')")
    expect(envelope(capture)['data']).toEqual([{ key: 1 }])

    // schema-qualified, and the clause is used exactly as written
    await runCaptured(dbCommand, ['sd', 'query', 'public.dispatch_orders', 'key > 0 order by key desc', '--json'])
    expect(duck.lastScript()).toContain(
      "postgres_query('sd', 'select * from public.dispatch_orders where key > 0 order by key desc')",
    )

    // a clause carrying a second statement is refused before anything runs
    const injected = await runCaptured(dbCommand, ['sd', 'query', 'dispatch_orders', '1 = 1; drop table x', '--json'])
    expect(injected.code).toBe(2)
    expect(String(errorOf(injected)['message'])).toContain('only one statement')

    const tableName = await runCaptured(dbCommand, ['sd', 'query', 'dispatch_orders', 'key; drop', '--json'])
    expect(tableName.code).toBe(2)
  })

  test('one argument is a statement, and nothing else is guessed', async () => {
    duck.reply('[{"n":1}]')
    await runCaptured(dbCommand, ['om', 'query', 'select 1 as n', '--json'])
    expect(duck.lastScript()).toContain("postgres_query('om', 'select 1 as n')")

    const tableAlone = await runCaptured(dbCommand, ['om', 'query', 'orders', '--json'])
    expect(tableAlone.code).toBe(2)
    expect(String(errorOf(tableAlone)['message'])).toContain('"orders" is a table, not a statement')
    expect(String(errorOf(tableAlone)['hint'])).toContain('two are a table and a WHERE clause')

    const three = await runCaptured(dbCommand, ['om', 'query', 'select', '1', 'as', 'n', '--json'])
    expect(three.code).toBe(2)
    expect(String(errorOf(three)['message'])).toContain('was given 4 arguments')
    expect(String(errorOf(three)['hint'])).toContain('one argument is a whole statement')

    const keyword = await runCaptured(dbCommand, ['om', 'query', 'select', '1', '--json'])
    expect(keyword.code).toBe(2)
    expect(String(errorOf(keyword)['message'])).toContain('"select" is not a table name')
    expect(duck.argv()).toHaveLength(1)
  })

  test('--file carries a whole statement', async () => {
    const path = join(scratch, 'query.sql')
    writeFileSync(path, 'select count(*) as n from orders;\n')
    const fromFile = await runCaptured(dbCommand, ['om', 'query', '--file', path, '--json'])
    expect(fromFile.code).toBe(0)
    expect(duck.lastScript()).toContain("postgres_query('om', 'select count(*) as n from orders;")

    const both = await runCaptured(dbCommand, ['om', 'query', 'select 1', '--file', path, '--json'])
    expect(both.code).toBe(2)
    expect(String(errorOf(both)['message'])).toContain('give a statement or --file, not both')

    const tableAndFile = await runCaptured(dbCommand, ['om', 'query', 'orders', 'id > 1', '--file', path, '--json'])
    expect(tableAndFile.code).toBe(2)
    expect(String(errorOf(tableAndFile)['message'])).toContain('give a statement or --file, not both')

    const neither = await runCaptured(dbCommand, ['om', 'query'])
    expect(neither.code).toBe(2)
    expect(neither.stderr).toContain('the statement is required')
  })

  test('every database is its own subject, with no flag to say so', async () => {
    duck.reply('[{"n":1}]')
    await runCaptured(dbCommand, ['agg', 'query', 'select 1 as n', '--json'])
    expect(duck.lastScript()).toContain("postgres_query('agg', 'select 1 as n')")
    expect(duck.lastScript()).toContain("ATTACH 'postgres://reader:one-password@192.168.86.141:5432/aggregator_gateway'")
  })

  test('rows are capped client-side and the cap is reported', async () => {
    duck.reply(JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]))
    const capture = await runCaptured(dbCommand, ['om', 'query', 'select n from t', '--limit', '2', '--json'])
    expect(envelope(capture)['data']).toHaveLength(2)
    expect(metaOf(capture)['truncated']).toBe(true)
  })

  test('--timeout must be a number of seconds', async () => {
    duck.reply('[{"n":1}]')
    const bogus = await runCaptured(dbCommand, ['om', 'query', 'select 1 as n', '--timeout', 'soon', '--json'])
    expect(bogus.code).toBe(2)
    expect(String(errorOf(bogus)['message'])).toContain('--timeout must be a positive number of seconds')
  })
})

describe('ops db all query', () => {
  test('one statement reaches several databases by naming them', async () => {
    duck.reply('[{"id":1}]')
    const capture = await runCaptured(dbCommand, [
      'all',
      'query',
      'select o.id from om.public.orders o join sd.public.orders s on s.id = o.id',
      '--json',
    ])
    expect(capture.code).toBe(0)
    expect(duck.argv()).toHaveLength(1)
    const script = duck.lastScript()
    expect(script).toContain('AS "om" (TYPE postgres, READ_ONLY)')
    expect(script).toContain('AS "sd" (TYPE postgres, READ_ONLY)')
    expect(script).not.toContain('AS "agg"')
    expect(metaOf(capture)['databases']).toEqual(['om', 'sd'])
    expect(metaOf(capture)['database']).toBeUndefined()
  })

  test('a statement that reaches no database connects to none', async () => {
    duck.reply('[{"n":1}]')
    const capture = await runCaptured(dbCommand, ['all', 'query', 'select 1 as n', '--json'])
    expect(capture.code).toBe(0)
    expect(duck.lastScript()).not.toContain('ATTACH')
  })

  test('a table named without its database is asked about, not guessed', async () => {
    duck.reply('', 1, 'Catalog Error: Table with name events does not exist!\n')
    const capture = await runCaptured(dbCommand, ['all', 'query', 'select * from events', '--json'])
    expect(capture.code).toBe(2)
    expect(String(errorOf(capture)['hint'])).toContain('<name>.public.<table>')
    expect(String(errorOf(capture)['hint'])).toContain('om')
  })

  test('the shorthand asks one database, and says which one', async () => {
    const bare = await runCaptured(dbCommand, ['all', 'query', 'orders', 'id > 5', '--json'])
    expect(bare.code).toBe(2)

    const qualified = await runCaptured(dbCommand, ['all', 'query', 'om.events', 'id > 5', '--json'])
    expect(qualified.code).toBe(2)
    expect(duck.argv()).toHaveLength(0)
  })

  test('verbs that need one server refuse all', async () => {
    const describe = await runCaptured(dbCommand, ['all', 'describe', 'orders', '--json'])
    expect(describe.code).toBe(2)
    expect(String(errorOf(describe)['message'])).toContain('describe asks one database')

    const whoami = await runCaptured(dbCommand, ['all', 'whoami', '--json'])
    expect(whoami.code).toBe(2)
    expect(String(errorOf(whoami)['message'])).toContain('whoami asks one database')
    expect(duck.argv()).toHaveLength(0)
  })
})

describe('ops db <database> <listing>', () => {
  test('tables, views, triggers and schemas each ask that server', async () => {
    const cases: Array<[string, string]> = [
      ['tables', "table_type = ''BASE TABLE''"],
      ['views', 'pg_matviews'],
      ['triggers', 'information_schema.triggers'],
      ['schemas', 'information_schema.schemata'],
    ]
    duck.reply('[{"schema":"public","name":"orders"}]')
    for (const [verb, needle] of cases) {
      const capture = await runCaptured(dbCommand, ['om', verb, '--json'])
      expect(capture.code, verb).toBe(0)
      expect(duck.lastScript(), verb).toContain(needle)
      expect(duck.lastScript(), verb).toContain("postgres_query('om',")
      expect((envelope(capture)['data'] as Record<string, unknown>[])[0]?.['database'], verb).toBe('om')
    }
  })

  test('a listing can cover every database, tagged with where each row came from', async () => {
    duck.reply('[{"name":"public"}]')
    const capture = await runCaptured(dbCommand, ['all', 'schemas', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([
      { database: 'agg', name: 'public' },
      { database: 'om', name: 'public' },
      { database: 'sd', name: 'public' },
    ])
    expect(metaOf(capture)['databases']).toEqual(['agg', 'om', 'sd'])
  })

  test('a database that does not answer is reported, not fatal, across all', async () => {
    duck.reply('', 1, 'IO Error: could not connect\n')
    const capture = await runCaptured(dbCommand, ['all', 'tables', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([])
    expect(metaOf(capture)['failed']).toHaveLength(3)
  })

  test('--pattern filters the names', async () => {
    duck.reply('[{"schema":"public","name":"dispatch_orders"},{"schema":"public","name":"events"}]')
    const capture = await runCaptured(dbCommand, ['sd', 'tables', '--pattern', 'dispatch', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([{ database: 'sd', schema: 'public', name: 'dispatch_orders' }])
  })

  test('databases lists what one server holds', async () => {
    duck.reply('[{"name":"smartdispatcher"}]')
    const capture = await runCaptured(dbCommand, ['sd', 'databases', '--json'])
    expect(capture.code).toBe(0)
    expect(duck.lastScript()).toContain("postgres_query('sd', 'select datname as name from pg_database order by 1')")
  })
})

describe('ops db <database> describe', () => {
  const COLUMNS = '[{"column":"id","type":"bigint","nullable":"NO","default":"nextval(\'orders_id_seq\'::regclass)"}]'

  test('a table name, bare or qualified', async () => {
    duck.reply(COLUMNS)
    const bare = await runCaptured(dbCommand, ['om', 'describe', 'orders', '--json'])
    expect(bare.code).toBe(0)
    expect(duck.lastScript()).toContain("where table_name = ''orders'' order by ordinal_position")
    expect(envelope(bare)['data']).toEqual(JSON.parse(COLUMNS))

    const qualified = await runCaptured(dbCommand, ['om', 'describe', 'public.orders', '--json'])
    expect(qualified.code).toBe(0)
    expect(duck.lastScript()).toContain("where table_name = ''orders'' and table_schema = ''public''")
  })

  test('a missing table is a not-found that says how to look', async () => {
    duck.reply('[]')
    const capture = await runCaptured(dbCommand, ['om', 'describe', 'nope', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('not-found')
  })

  test('a name that is not a table name, or no name at all', async () => {
    for (const name of ['orders; drop table x', 'a..b', 'orders extra']) {
      const bad = await runCaptured(dbCommand, ['om', 'describe', name, '--json'])
      expect(bad.code, name).toBe(2)
    }
    const missing = await runCaptured(dbCommand, ['om', 'describe', '--json'])
    expect(missing.code).toBe(2)
    expect(String(errorOf(missing)['message'])).toContain('a table name is required')
    expect(duck.argv()).toHaveLength(0)
  })
})

describe('ops db <database> whoami', () => {
  test('asks that server for its identity', async () => {
    duck.reply('[{"username":"smartdispatcher","database":"smartdispatcher","version":"PostgreSQL 13.23"}]')
    const capture = await runCaptured(dbCommand, ['sd', 'whoami', '--json'])
    expect(capture.code).toBe(0)
    expect(duck.lastScript()).toContain("postgres_query('sd', 'select current_user as username")
    expect(metaOf(capture)['database']).toBe('sd')
  })
})

describe('what a wrong database name does', () => {
  test('an unknown database lists the configured ones', async () => {
    const capture = await runCaptured(dbCommand, ['nope', 'tables', '--json'])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(String(errorOf(capture)['hint'])).toContain('agg, om, sd')
    expect(duck.argv()).toHaveLength(0)
  })
})

describe('the guard still stands between the operator and a write', () => {
  test('a write never reaches a database, in any spelling', async () => {
    const writes = [
      'insert into orders values (1)',
      'delete from orders',
      "copy orders to '/tmp/x.csv'",
      'create table x as select 1',
      'drop table orders',
    ]
    for (const sql of writes) {
      const capture = await runCaptured(dbCommand, ['om', 'query', sql, '--json'])
      expect(capture.code, sql).toBe(2)
      expect(errorOf(capture)['kind'], sql).toBe('usage')
    }
    expect(duck.argv()).toHaveLength(0)
  })

  test('the layer function is not a function of any database', async () => {
    const capture = await runCaptured(dbCommand, ['om', 'query', "select * from postgres_query('om', 'delete from t')", '--json'])
    expect(capture.code).toBe(2)
    expect(String(errorOf(capture)['message'])).toContain('"postgres_query" is not a function of a configured database')
    expect(duck.argv()).toHaveLength(0)
  })

  test('two statements in one call are refused', async () => {
    const capture = await runCaptured(dbCommand, ['om', 'query', 'select 1; select 2', '--json'])
    expect(capture.code).toBe(2)
    expect(String(errorOf(capture)['message'])).toContain('only one statement')
  })
})

