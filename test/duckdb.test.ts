import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpsError } from '../src/errors.ts'
import {
  DUCKDB_PREAMBLE,
  duckArgv,
  duckdbError,
  registerScriptSecrets,
  rowsFrom,
  runDuckdb,
  sqlIdentifier,
  sqlLiteral,
} from '../src/duckdb.ts'
import { installFakeDuckdb, type FakeDuckdb } from './helpers/fake-duckdb.ts'

let duck: FakeDuckdb

beforeAll(() => {
  duck = installFakeDuckdb()
})

afterAll(() => {
  duck.restore()
})

beforeEach(() => {
  duck.reply('[]')
})

describe('the duckdb argv', () => {
  test('ignores the rc file, and sets the output mode in the script instead', () => {
    expect(duckArgv()).toEqual(['duckdb', '-init', '/dev/null'])
    expect(DUCKDB_PREAMBLE).toBe('.mode jsonlines\n.pager off\n')
  })

  test('opens a local database, read-only when asked, and never carries a DSN', () => {
    expect(duckArgv({ database: '/tmp/ops.duckdb' })).toEqual(['duckdb', '-init', '/dev/null', '/tmp/ops.duckdb'])
    expect(duckArgv({ database: '/tmp/ops.duckdb', readOnly: true })).toEqual([
      'duckdb',
      '-init',
      '/dev/null',
      '-readonly',
      '/tmp/ops.duckdb',
    ])
    expect(duckArgv({ database: '~/x.duckdb' })[3]).toBe(`${process.env['HOME']}/x.duckdb`)
  })
})

describe('the SQL literals', () => {
  test('quotes a value and an identifier the way DuckDB does', () => {
    expect(sqlLiteral("p'w")).toBe(`'p''w'`)
    expect(sqlIdentifier('we"ird')).toBe(`"we""ird"`)
  })
})

/** A line as the config file carries it: built by the operator, not by a helper. */
const LINE = "ATTACH 'postgresql://u:secret@h/d' AS sd (TYPE postgres, READ_ONLY);\n" 

describe('reading the output', () => {
  test('one object per line, however wide the row', async () => {
    // A row with a nested list would have been wrapped by `mode json`.
    duck.reply(
      '{"database":"sd","schema":"public","name":"as400_products_complements","column_names":["id","code","name"],"temporary":false}\n' +
        '{"database":"sd","schema":"public","name":"dispatch_orders","column_names":["id"],"temporary":false}\n',
    )
    const result = await runDuckdb('SHOW ALL TABLES;\n')
    expect(result.rows.map((row) => row['name'])).toEqual(['as400_products_complements', 'dispatch_orders'])
  })

  test('a value containing a newline stays one row, because JSON escapes it', () => {
    expect(rowsFrom('{"body":"line one\\nline two"}\n')).toEqual([{ body: 'line one\nline two' }])
  })

  test('an array line is still read as rows', () => {
    expect(rowsFrom('[{"a":1},{"a":2}]\n')).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('an empty result is no rows, and non-JSON is an upstream failure', async () => {
    duck.reply('\n')
    expect((await runDuckdb('select 1;')).rows).toEqual([])

    duck.reply('not json at all\n')
    await expect(runDuckdb('select 1;')).rejects.toThrow(OpsError)
  })

  test('the script is the only thing that carries the DSN, preamble included', async () => {
    duck.reply('[]')
    await runDuckdb(`${LINE}select 1;\n`)
    expect(duck.argv()[0]?.join(' ')).not.toContain('secret')
    const script = duck.lastScript()
    expect(script).toStartWith('.mode jsonlines\n.pager off\n')
    expect(script).toContain('postgresql://u:secret@h/d')
  })
})

describe('failures', () => {
  test('a SQL mistake is a usage error, an IO failure is upstream', () => {
    expect(duckdbError('Catalog Error: Table with name nope does not exist!').kind).toBe('usage')
    expect(duckdbError('Parser Error: syntax error at or near "1"').kind).toBe('usage')
    expect(duckdbError('IO Error: No files found that match the pattern').kind).toBe('upstream')
  })

  test('a DSN echoed by DuckDB never reaches the message', async () => {
    const dsn = 'postgresql://user:sup3rs3cret@db.internal:5432/app'
    registerScriptSecrets([dsn])
    duck.reply('', 1, `IO Error: Unable to connect to Postgres at "${dsn}": password authentication failed`)
    try {
      await runDuckdb(`ATTACH '${dsn}' AS sd (TYPE postgres, READ_ONLY);\nselect 1;\n`)
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('upstream')
      expect((error as OpsError).message).not.toContain('sup3rs3cret')
      expect((error as OpsError).message).toContain('[redacted]')
    }
  })

  // Bun resolves an executable once per process, so emptying PATH here would
  // still find the fake; a child process has no such cache.
  test('a missing binary is a config error whose hint says what to install', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ops-no-bins-'))
    const script = [
      `import { runDuckdb } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'duckdb.ts'))}`,
      'try {',
      "  await runDuckdb('select 1;')",
      "  console.log('no error')",
      '} catch (error) {',
      "  console.log(JSON.stringify({ kind: error.kind, message: error.message, hint: error.hint }))",
      '}',
    ].join('\n')
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { PATH: empty },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const reported = JSON.parse(stdout) as { kind: string; message: string; hint: string }
    expect(reported.kind).toBe('config')
    expect(reported.hint).toContain('duckdb')
    rmSync(empty, { recursive: true, force: true })
  })
})
