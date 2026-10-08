import { describe, expect, test } from 'bun:test'
import { OpsError } from 'crafty'
import { assertReadOnly, postgresQueryCalls, scan, type SqlDialect } from '../lib/sql-guard.ts'

function kindOf(sql: string, dialect: SqlDialect = 'postgres'): string | null {
  try {
    assertReadOnly(sql, dialect)
    return null
  } catch (error) {
    if (error instanceof OpsError) return error.kind
    throw error
  }
}

describe('assertReadOnly', () => {
  test('accepts the reads both dialects use', () => {
    const allowed: [string, SqlDialect][] = [
      ['select 1', 'postgres'],
      ['SELECT * FROM users WHERE id = 1', 'postgres'],
      ['select 1;', 'postgres'],
      ['select 1;\n', 'postgres'],
      ['with x as (select 1) select * from x', 'postgres'],
      ['show databases', 'postgres'],
      ['explain select 1', 'postgres'],
      ['table users', 'postgres'],
      ['values (1)', 'postgres'],
      ['-- a comment\nselect 1', 'postgres'],
      ['/* block */ select 1', 'postgres'],
      ["select 'drop'", 'postgres'],
      ['select "delete" from t', 'postgres'],
      ['select count() from signoz_logs.logs_v2', 'clickhouse'],
      ['describe table signoz_logs.logs_v2', 'clickhouse'],
      ['desc signoz_logs.logs_v2', 'clickhouse'],
      ['exists signoz_logs.logs_v2', 'clickhouse'],
      ['system tables', 'clickhouse'],
      ["select fromUnixTimestamp64Nano(timestamp) as ts, body from logs where positionCaseInsensitive(body, 'delete') > 0", 'clickhouse'],
    ]
    for (const [sql, dialect] of allowed) expect(kindOf(sql, dialect), sql).toBeNull()
  })

  test('refuses writes', () => {
    const rejected = [
      'DELETE FROM t',
      'drop table x',
      'insert into t values (1)',
      'update t set a = 1',
      'select 1 into backup',
      'truncate t',
      'set x = 1',
      'begin',
      'grant all on t to u',
      'call do_thing()',
      'optimize table t final',
      'kill query where 1',
      'copy t from stdin',
      'alter table t add column c int',
      'create table x (a int)',
    ]
    for (const sql of rejected) expect(kindOf(sql), sql).toBe('usage')
  })

  test('refuses more than one statement, however it is spelled', () => {
    for (const sql of ['select 1; drop table x', 'select 1; select 2', 'select 1;;']) {
      expect(kindOf(sql), sql).toBe('usage')
    }
  })

  test('a semicolon inside a string is not a statement separator', () => {
    expect(kindOf(`select ';'`)).toBeNull()
    expect(kindOf(`select 'a;b' from t`)).toBeNull()
  })

  test('refuses a leading keyword the dialect does not read with', () => {
    expect(kindOf('drop table x')).toBe('usage')
    expect(kindOf('vacuum', 'postgres')).toBe('usage')
    expect(kindOf('select 1', 'clickhouse')).toBeNull()
    expect(kindOf('show tables', 'clickhouse')).toBeNull()
  })

  test('refuses nothing at all', () => {
    expect(kindOf('')).toBe('usage')
    expect(kindOf('   \n  ')).toBe('usage')
    expect(kindOf('-- just a comment')).toBe('usage')
  })
})

describe('the DuckDB push-down statement', () => {
  test('is read too, because the outer scan only sees a string', () => {
    expect(kindOf("select * from postgres_query('om', 'select id from events order by id desc limit 5')", 'duckdb')).toBeNull()
    expect(kindOf("select * from postgres_query('om', 'insert into events (id) values (1) returning id')", 'duckdb')).toBe('usage')
    expect(kindOf("select * from postgres_query('om', 'delete from events where id = 1')", 'duckdb')).toBe('usage')
    expect(kindOf("select * from postgres_query('om', 'select 1') join sd.t on true", 'duckdb')).toBeNull()
  })

  test('escaped quotes inside it are unescaped before the check', () => {
    expect(kindOf('select * from postgres_query(\'om\', \'select \'\'drop\'\' as x\')', 'duckdb')).toBeNull()
    expect(kindOf('select * from postgres_query(\'om\', \'select 1\'\'\'\' ; drop table x\')', 'duckdb')).toBe('usage')
    expect(postgresQueryCalls('select * from postgres_query(\'om\', \'select \'\'a\'\'\')')).toEqual(["select 'a'"])
  })

  test('a double-quoted alias is accepted, and the field order does not matter', () => {
    expect(postgresQueryCalls('select * from POSTGRES_QUERY("om", \'select 1\')')).toEqual(['select 1'])
    expect(postgresQueryCalls('select 1')).toEqual([])
  })

  test('the postgres dialect is unaffected', () => {
    expect(kindOf("select * from postgres_query('om', 'insert into events (id) values (1)')", 'postgres')).toBeNull()
  })
})

describe('scan', () => {
  test('counts statements and blanks what is not code', () => {
    expect(scan("select 'a;b' -- x\nfrom t").statements).toBe(0)
    expect(scan("select 'a;b';").statements).toBe(1)
    expect(scan('select 1 /* ; */ ;').statements).toBe(1)
    expect(scan("select 'a;b' from t").skeleton).toBe('select   from t')
  })

  test('collects words only outside strings and comments', () => {
    expect(scan("select 'drop' /* insert */ from t -- delete").words).toEqual(['select', 'from', 't'])
  })
})
