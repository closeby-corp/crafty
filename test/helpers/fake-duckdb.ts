import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeDuckdb {
  /** Every invocation's argv, in order. */
  argv(): string[][]
  /** The script each invocation received on stdin, in order. */
  stdin(): string[]
  lastScript(): string
  /** What the next call prints / exits with. */
  reply(stdout: string, exitCode?: number, stderr?: string): void
  /** Forget the calls so far, so a test can assert on its own. */
  reset(): void
  restore(): void
}

/** Records how it was called, then answers from the environment. */
const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const argvFile = Bun.env['FAKE_DUCKDB_ARGV_FILE']
const stdinFile = Bun.env['FAKE_DUCKDB_STDIN_FILE']
const stdin = await new Response(Bun.stdin.stream()).text()
if (argvFile) appendFileSync(argvFile, JSON.stringify(Bun.argv.slice(2)) + '\\n')
if (stdinFile) appendFileSync(stdinFile, JSON.stringify(stdin) + '\\n')
const stdout = Bun.env['FAKE_DUCKDB_STDOUT']
if (stdout) process.stdout.write(stdout)
const stderr = Bun.env['FAKE_DUCKDB_STDERR']
if (stderr) process.stderr.write(stderr)
process.exit(Number(Bun.env['FAKE_DUCKDB_EXIT'] ?? '0'))
`

/** Puts a `duckdb` on PATH that records its argv and stdin, and prints canned JSON. */
export function installFakeDuckdb(): FakeDuckdb {
  const dir = mkdtempSync(join(tmpdir(), 'ops-fake-duckdb-'))
  const binary = join(dir, 'duckdb')
  const argvFile = join(dir, 'argv.log')
  const stdinFile = join(dir, 'stdin.log')
  const originalPath = process.env['PATH'] ?? ''

  writeFileSync(binary, SCRIPT)
  chmodSync(binary, 0o755)
  writeFileSync(argvFile, '')
  writeFileSync(stdinFile, '')
  process.env['PATH'] = `${dir}:${originalPath}`
  process.env['FAKE_DUCKDB_ARGV_FILE'] = argvFile
  process.env['FAKE_DUCKDB_STDIN_FILE'] = stdinFile

  const lines = (path: string): string[] =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')

  return {
    argv: () => lines(argvFile).map((line) => JSON.parse(line) as string[]),
    stdin: () => lines(stdinFile).map((line) => JSON.parse(line) as string),
    lastScript: () => {
      const all = lines(stdinFile)
      const last = all.at(-1)
      return last === undefined ? '' : (JSON.parse(last) as string)
    },
    reply: (stdout, exitCode = 0, stderr = '') => {
      process.env['FAKE_DUCKDB_STDOUT'] = stdout
      process.env['FAKE_DUCKDB_EXIT'] = String(exitCode)
      process.env['FAKE_DUCKDB_STDERR'] = stderr
    },
    reset: () => {
      writeFileSync(argvFile, '')
      writeFileSync(stdinFile, '')
      process.env['FAKE_DUCKDB_STDOUT'] = ''
      process.env['FAKE_DUCKDB_STDERR'] = ''
      process.env['FAKE_DUCKDB_EXIT'] = '0'
    },
    restore: () => {
      process.env['PATH'] = originalPath
      for (const name of [
        'FAKE_DUCKDB_ARGV_FILE',
        'FAKE_DUCKDB_STDIN_FILE',
        'FAKE_DUCKDB_STDOUT',
        'FAKE_DUCKDB_STDERR',
        'FAKE_DUCKDB_EXIT',
      ]) {
        delete process.env[name]
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
