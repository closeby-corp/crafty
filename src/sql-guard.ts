/**
 * The only thing standing between `--sql` and a write. Quoting and comments are
 * honoured, so a keyword inside a string literal is a value, not a statement.
 */
import { OpsError } from './errors.ts'

export type SqlDialect = 'postgres' | 'clickhouse' | 'duckdb'

const LEADING: Record<SqlDialect, readonly string[]> = {
  postgres: ['select', 'with', 'show', 'explain', 'table', 'values'],
  clickhouse: ['select', 'with', 'show', 'describe', 'desc', 'explain', 'exists', 'system'],
  duckdb: ['select', 'with', 'show', 'describe', 'desc', 'summarize', 'from', 'table', 'values', 'explain', 'pragma'],
}

/** Words that turn a read into a write, or into something with side effects. */
const FORBIDDEN: readonly string[] = [
  'insert',
  'update',
  'delete',
  'drop',
  'create',
  'alter',
  'grant',
  'revoke',
  'truncate',
  'copy',
  'into',
  'attach',
  'detach',
  'rename',
  'call',
  'do',
  'set',
  'reset',
  'begin',
  'commit',
  'rollback',
  'optimize',
  'kill',
  'format',
]

/**
 * Per dialect, what the shared list misses or must not reject. DuckDB has no
 * `FORMAT` clause (only the `format()` function, which is a read), and it can
 * reach a database this CLI never configured through ATTACH or an extension, so
 * those words are refused there on top of the shared list.
 */
const EXTRA_FORBIDDEN: Partial<Record<SqlDialect, readonly string[]>> = {
  duckdb: ['load', 'install', 'export', 'import', 'secret', 'checkpoint', 'vacuum', 'use', 'force'],
}

const ALLOWED_DESPITE_SHARED: Partial<Record<SqlDialect, readonly string[]>> = {
  duckdb: ['format'],
}

export interface ScannedSql {
  /** The statement with strings and comments blanked out. */
  skeleton: string
  words: string[]
  statements: number
}

/** Blanks out quoted strings, `--` line comments and slash-star block comments. */
export function scan(sql: string): ScannedSql {
  let skeleton = ''
  const words: string[] = []
  let word = ''
  let statements = 0
  let index = 0

  const flush = (): void => {
    if (word !== '') words.push(word.toLowerCase())
    word = ''
  }

  while (index < sql.length) {
    const char = sql[index]!
    const next = sql[index + 1]

    if (char === "'" || char === '"' || char === '`') {
      flush()
      const quote = char
      index += 1
      while (index < sql.length) {
        if (sql[index] === '\\' && quote === "'") {
          index += 2
          continue
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      skeleton += ' '
      continue
    }

    if (char === '-' && next === '-') {
      flush()
      while (index < sql.length && sql[index] !== '\n') index += 1
      skeleton += ' '
      continue
    }

    if (char === '/' && next === '*') {
      flush()
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index += 2
      skeleton += ' '
      continue
    }

    if (char === ';') {
      flush()
      statements += 1
      skeleton += ';'
      index += 1
      continue
    }

    if (/[A-Za-z0-9_$]/.test(char)) {
      word += char
      skeleton += char
      index += 1
      continue
    }

    flush()
    skeleton += char === '\n' ? ' ' : char
    index += 1
  }
  flush()
  return { skeleton, words, statements }
}

/**
 * The SQL passed to DuckDB's `postgres_query(alias, '...')`: it runs on the server
 * with a database's own privileges, and the outer scan cannot see it, because to
 * that scan it is a string literal.
 */
export function postgresQueryCalls(sql: string): string[] {
  const calls: string[] = []
  const pattern = /postgres_query\s*\(\s*(?:'(?:[^']|'')*'|"(?:[^"]|"")*"|[^,)]+)\s*,\s*'((?:[^']|'')*)'/gi
  for (const match of sql.matchAll(pattern)) calls.push(match[1]!.replaceAll("''", "'"))
  return calls
}

/**
 * Refuses anything that is not one read-only statement of the given dialect.
 * The message names what it saw, so a knife-edged guard is never a mystery.
 */
export function assertReadOnly(sql: string, dialect: SqlDialect): void {
  const { skeleton, words } = scan(sql)
  const trimmed = skeleton.trim()

  if (trimmed === '') throw new OpsError('the SQL is empty', 'usage')

  // One statement only: a single `;` is allowed, and only at the end.
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
  if (body.includes(';')) {
    throw new OpsError('only one statement may be sent at a time', 'usage', {
      hint: 'split them into separate calls',
    })
  }

  const leading = words[0]
  if (leading === undefined) throw new OpsError('the SQL has no statement to read', 'usage')

  const forbidden = [
    ...FORBIDDEN.filter((word) => !(ALLOWED_DESPITE_SHARED[dialect] ?? []).includes(word)),
    ...(EXTRA_FORBIDDEN[dialect] ?? []),
  ]
  for (const word of words) {
    if (forbidden.includes(word)) {
      throw new OpsError(`"${word}" is not allowed: this CLI only reads`, 'usage', { hint: hintFor(dialect) })
    }
  }

  if (!LEADING[dialect].includes(leading)) {
    throw new OpsError(`"${leading}" is not a read-only statement`, 'usage', {
      hint: `read-only statements start with one of: ${LEADING[dialect].join(', ')}`,
    })
  }

  // DuckDB's push-down function carries its own statement, which the scan above
  // only ever saw as a string: read it too, as the server would.
  if (dialect === 'duckdb') {
    for (const inner of postgresQueryCalls(sql)) {
      try {
        assertReadOnly(inner, 'postgres')
      } catch (error) {
        if (error instanceof OpsError && error.kind === 'usage') {
          throw new OpsError(error.message, 'usage', { hint: hintFor('duckdb') })
        }
        throw error
      }
    }
  }
}

function hintFor(dialect: SqlDialect): string {
  return dialect === 'clickhouse'
    ? 'crafty signoz reads the logs database; run a write through clickhouse-client directly'
    : 'crafty db opens every database read-only; run a write through psql directly'
}
