/**
 * DuckDB as a connection layer: attach the configured Postgres databases
 * read-only and query them, plus local files, from one SQL engine.
 *
 * Everything goes through the `duckdb` binary - no runtime dependency - with the
 * script on **stdin**, so a DSN carrying a password never lands in `ps`. A
 * failure DuckDB echoes can contain that DSN, so its stderr is redacted.
 */
import { exec } from './exec.ts'
import { OpsError } from './errors.ts'
import { redactString, registerSecret } from './log.ts'
import { expandHome } from './targets.ts'

export const DUCKDB_BINARY = 'duckdb'

/**
 * Prefixed to every script. `jsonlines` is one JSON object per line with no
 * wrapping, unlike `json`, which breaks a long array across lines for
 * readability; `pager off` matters because DuckDB otherwise pages a large
 * result, and a pager in a spawned process would wait forever.
 */
export const DUCKDB_PREAMBLE = '.mode jsonlines\n.pager off\n'

export interface DuckOptions {
  /** A local database file; in-memory when absent. */
  database?: string
  /** Open the local database read-only too. */
  readOnly?: boolean
  timeoutMs?: number
}

export interface DuckResult {
  rows: Record<string, unknown>[]
  durationMs: number
  stderr: string
}

/** Never the operator's rc file: that file can contain arbitrary SQL. */
export function duckArgv(options: DuckOptions = {}): string[] {
  const argv = [DUCKDB_BINARY, '-init', '/dev/null']
  if (options.readOnly === true) argv.push('-readonly')
  if (options.database !== undefined && options.database !== '') argv.push(expandHome(options.database))
  return argv
}

/** A single-quoted SQL string, the way DuckDB escapes one. */
export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** A double-quoted identifier, so a name from a statement can be anything. */
export function sqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/** The DuckDB error class, mapped to the CLI's vocabulary. */
export function duckdbError(stderr: string): OpsError {
  const message = redactString(stderr.trim().split('\n').filter((line) => line !== '').slice(0, 3).join(' '))
  const text = message === '' ? 'duckdb failed without saying why' : message
  if (/Catalog Error|Parser Error|Binder Error|Invalid Input Error|Permission Error/i.test(text)) {
    return new OpsError(text, 'usage')
  }
  if (/IO Error|Unable to connect|Could not|Connection/i.test(text)) {
    return new OpsError(text, 'upstream')
  }
  return new OpsError(text, 'upstream')
}

/** One row per line, as `jsonlines` writes it. An array line is tolerated. */
export function rowsFrom(stdout: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new OpsError(`duckdb printed something that is not JSON: ${redactString(text.slice(0, 200))}`, 'upstream')
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        rows.push(entry as Record<string, unknown>)
      }
    }
  }
  return rows
}

/**
 * Runs a script and returns its rows. The attach statements print nothing, so
 * everything that comes back belongs to the statement the operator wrote.
 */
export async function runDuckdb(script: string, options: DuckOptions = {}): Promise<DuckResult> {
  let result: { stdout: string; stderr: string; exitCode: number; durationMs: number }
  try {
    result = await exec(duckArgv(options), {
      stdin: `${DUCKDB_PREAMBLE}${script}`,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      allowFailure: true,
    })
  } catch (error) {
    if (error instanceof OpsError && error.kind === 'config') {
      // The one message that has to name the binary: without it on PATH nothing
      // in this group can reach a database, and a hint has to be actionable.
      throw new OpsError('the SQL engine crafty db uses is not on PATH', 'config', {
        hint: `install \`${DUCKDB_BINARY}\` (brew/apt install duckdb), then run this again`,
      })
    }
    if (error instanceof OpsError && error.status === 124) {
      throw new OpsError(error.message, 'network', {
        status: 124,
        hint: 'an attached database is read row by row: filter the statement so the work happens on the server, or raise --timeout',
      })
    }
    throw error
  }

  if (result.exitCode !== 0) throw duckdbError(result.stderr)
  return { rows: rowsFrom(result.stdout), durationMs: result.durationMs, stderr: result.stderr }
}

/** Registers every DSN in a script for redaction before it can be echoed. */
export function registerScriptSecrets(dsns: string[]): void {
  for (const dsn of dsns) registerSecret(dsn)
}
