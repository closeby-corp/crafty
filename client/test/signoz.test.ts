import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitArgv } from '../lib/argv.ts'
import signozCommand from '../commands/signoz.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { installFakeSsh, type FakeSsh } from './helpers/fake-ssh.ts'

let ssh: FakeSsh
const scratch = mkdtempSync(join(tmpdir(), 'ops-signoz-'))
const configPath = join(scratch, 'config.yml')

const CONFIG = [
  'targets:',
  '  signoz:',
  '    kind: signoz',
  '    via: ssh',
  '    ssh_host: uq-observability',
  '    container: signoz-clickhouse',
  '    database: signoz_logs',
  '    logs_table: logs_v2',
  '    time_column: timestamp',
  '',
].join('\n')

/** What `clickhouse-client --format JSON` prints for one result set. */
function chReply(data: unknown[]): string {
  return JSON.stringify({ meta: [], data, rows: data.length, statistics: {} })
}

beforeAll(() => {
  ssh = installFakeSsh()
  writeFileSync(configPath, CONFIG)
})

afterAll(() => {
  delete process.env['OPS_CONFIG']
  ssh.restore()
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  ssh.reset()
  process.env['OPS_CONFIG'] = configPath
  resetConfigCache()
})

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

/** The command the remote shell would run: the one quoted argument, unquoted. */
function remoteArgv(): string[] {
  return splitArgv(ssh.lastRemoteArgv()[0] ?? '')
}

/**
 * The shared fake does not read stdin, and it is locked, so stdin assertions
 * use a smaller shim that reports both argv and what it received on stdin.
 */
interface CaptureSsh {
  last(): { argv: string[]; stdin: string } | null
  reply(stdout: string): void
  restore(): void
}

function installCaptureSsh(): CaptureSsh {
  const dir = mkdtempSync(join(tmpdir(), 'ops-signoz-stdin-'))
  const binary = join(dir, 'ssh')
  const log = join(dir, 'log.jsonl')
  writeFileSync(log, '')
  const script = [
    '#!/usr/bin/env bun',
    "import { appendFileSync } from 'node:fs'",
    'const stdin = await Bun.stdin.text()',
    "const entry = JSON.stringify({ argv: Bun.argv.slice(2), stdin }) + '\\n'",
    "appendFileSync(Bun.env['CAPTURE_LOG'], entry)",
    "process.stdout.write(Bun.env['CAPTURE_REPLY'] ?? '')",
    '',
  ].join('\n')
  writeFileSync(binary, script)
  chmodSync(binary, 0o755)
  const previousPath = process.env['PATH'] ?? ''
  process.env['PATH'] = `${dir}:${previousPath}`
  process.env['CAPTURE_LOG'] = log
  return {
    last: () => {
      const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '')
      const last = lines.at(-1)
      return last === undefined ? null : (JSON.parse(last) as { argv: string[]; stdin: string })
    },
    reply: (stdout) => {
      process.env['CAPTURE_REPLY'] = stdout
    },
    restore: () => {
      process.env['PATH'] = previousPath
      delete process.env['CAPTURE_LOG']
      delete process.env['CAPTURE_REPLY']
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('ops signoz databases', () => {
  test('runs clickhouse-client in the container and unwraps the data array', async () => {
    ssh.reply(chReply([{ name: 'signoz_logs' }, { name: 'default' }]))
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(0)
    expect(remoteArgv()).toEqual([
      'docker',
      'exec',
      '-i',
      'signoz-clickhouse',
      'clickhouse-client',
      '--format',
      'JSON',
      '--database',
      'signoz_logs',
    ])
    // The SQL never travels as an argument; `--query` would be mangled by two shells.
    expect(remoteArgv()).not.toContain('--query')
    const body = envelope(capture)
    expect(body['ok']).toBe(true)
    expect(body['source']).toBe('signoz')
    expect(body['target']).toBe('signoz')
    expect(body['data']).toEqual([{ name: 'signoz_logs' }, { name: 'default' }])
    expect((body['meta'] as Record<string, unknown>)['count']).toBe(2)
  })

  test('an empty reply is an empty row set, not an error', async () => {
    ssh.reply('')
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([])
  })

  test('a reply that is not JSON is an upstream failure', async () => {
    ssh.reply('Code: 81. DB::Exception: Database xyz does not exist\n')
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('upstream')
  })

  test('a reply without a data array is an upstream failure', async () => {
    ssh.reply(JSON.stringify({ meta: [], rows: 0 }))
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('upstream')
  })

  test('a failing remote command maps to the remote kind', async () => {
    ssh.reply('', 'Error response from daemon: No such container\n')
    ssh.exit(1)
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('remote')
  })
})

describe('ops signoz and stdin', () => {
  let shim: CaptureSsh

  beforeAll(() => {
    shim = installCaptureSsh()
  })

  afterAll(() => {
    shim.restore()
  })

  beforeEach(() => {
    shim.reply(chReply([]))
  })

  test('SHOW DATABASES arrives on stdin, never as --query', async () => {
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(0)
    const received = shim.last()
    expect(received?.stdin).toBe('SHOW DATABASES')
    expect(received?.argv.join(' ')).not.toContain('--query')
  })

  test('tables defaults to the target database', async () => {
    await runCaptured(signozCommand, ['tables', '--json'])
    expect(shim.last()?.stdin).toBe('SHOW TABLES FROM signoz_logs')
  })

  test('tables honours --database', async () => {
    await runCaptured(signozCommand, ['tables', '--database', 'system', '--json'])
    expect(shim.last()?.stdin).toBe('SHOW TABLES FROM system')
  })

  test('describe qualifies the table with the target database', async () => {
    await runCaptured(signozCommand, ['describe', 'logs_v2', '--json'])
    expect(shim.last()?.stdin).toBe('DESCRIBE TABLE signoz_logs.logs_v2')
  })

  test('query sends the statement it was given', async () => {
    const sql = 'SELECT count() FROM signoz_logs.logs_v2'
    await runCaptured(signozCommand, ['query', '--sql', sql, '--json'])
    expect(shim.last()?.stdin).toBe(sql)
  })

  test('logs builds the nanosecond window with filters and a limit', async () => {
    await runCaptured(signozCommand, [
      'logs',
      '--since',
      '1h',
      '--grep',
      'timeout',
      '--severity',
      'ERROR',
      '--limit',
      '3',
      '--json',
    ])
    const sql = shim.last()?.stdin ?? ''
    expect(sql).toBe(
      [
        "SELECT fromUnixTimestamp64Nano(timestamp) AS ts, severity_text, resources_string['host.name'] AS host, body",
        'FROM signoz_logs.logs_v2',
        'WHERE timestamp >= toUInt64(toUnixTimestamp64Nano(now64(9)) - 3600000000000)',
        "  AND severity_text IN ('ERROR')",
        "  AND positionCaseInsensitive(body, 'timeout') > 0",
        'ORDER BY timestamp DESC',
        'LIMIT 3',
      ].join('\n'),
    )
  })

  test('logs sends no filter clauses when none were asked for', async () => {
    await runCaptured(signozCommand, ['logs', '--json'])
    const sql = shim.last()?.stdin ?? ''
    expect(sql).not.toContain('severity_text IN')
    expect(sql).not.toContain('positionCaseInsensitive')
    expect(sql).toContain('ORDER BY timestamp DESC')
    expect(sql).toContain('LIMIT 200')
  })

  test('logs takes repeated and comma-separated severities', async () => {
    await runCaptured(signozCommand, ['logs', '--severity', 'ERROR,FATAL', '--severity', 'WARN', '--json'])
    expect(shim.last()?.stdin).toContain("severity_text IN ('ERROR', 'FATAL', 'WARN')")
  })

  test('a grep containing a quote stays one ClickHouse literal', async () => {
    await runCaptured(signozCommand, ['logs', '--grep', "it's down", '--json'])
    expect(shim.last()?.stdin).toContain("positionCaseInsensitive(body, 'it\\'s down') > 0")
  })
})

describe('ops signoz query', () => {
  test('reads the statement from --file', async () => {
    const path = join(scratch, 'statement.sql')
    writeFileSync(path, 'SELECT 1 AS one')
    ssh.reply(chReply([{ one: 1 }]))
    const capture = await runCaptured(signozCommand, ['query', '--file', path, '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([{ one: 1 }])
  })

  test('requires exactly one of --sql and --file', async () => {
    const neither = await runCaptured(signozCommand, ['query', '--json'])
    expect(neither.code).toBe(2)

    const both = await runCaptured(signozCommand, ['query', '--sql', 'SELECT 1', '--file', 'x.sql', '--json'])
    expect(both.code).toBe(2)
    expect(ssh.argv()).toHaveLength(0)
  })

  test('a multi-statement write is refused before anything is contacted', async () => {
    const capture = await runCaptured(signozCommand, [
      'query',
      '--sql',
      'SELECT 1; DROP TABLE signoz_logs.logs_v2',
      '--json',
    ])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(ssh.argv()).toHaveLength(0)
  })

  test('a write keyword is refused', async () => {
    const capture = await runCaptured(signozCommand, ['query', '--sql', 'INSERT INTO t VALUES (1)', '--json'])
    expect(capture.code).toBe(2)
    expect(ssh.argv()).toHaveLength(0)
  })
})

describe('ops signoz logs rows and caps', () => {
  test('unwraps the reply into the fixed column order', async () => {
    ssh.reply(
      chReply([
        { ts: '2026-10-07 14:22:06.414696384', severity_text: 'ERROR', host: 'uqcraft101', body: 'boom' },
      ]),
    )
    const capture = await runCaptured(signozCommand, ['logs', '--json'])
    expect(capture.code).toBe(0)
    const data = envelope(capture)['data'] as Record<string, unknown>[]
    expect(data).toEqual([
      { ts: '2026-10-07 14:22:06.414696384', severity_text: 'ERROR', host: 'uqcraft101', body: 'boom' },
    ])
    expect((envelope(capture)['meta'] as Record<string, unknown>)['truncated']).toBe(false)
  })

  test('caps the row set at settings.max_rows and flags it truncated', async () => {
    const cappedPath = join(scratch, 'capped.yml')
    writeFileSync(cappedPath, `${CONFIG}settings:\n  max_rows: 2\n`)
    process.env['OPS_CONFIG'] = cappedPath
    resetConfigCache()
    ssh.reply(chReply([{ name: 'a' }, { name: 'b' }, { name: 'c' }]))
    const capture = await runCaptured(signozCommand, ['databases', '--json'])
    expect(capture.code).toBe(0)
    expect(envelope(capture)['data']).toEqual([{ name: 'a' }, { name: 'b' }])
    expect((envelope(capture)['meta'] as Record<string, unknown>)['truncated']).toBe(true)
  })
})

describe('ops signoz argument handling', () => {
  test('an unknown --since is a usage error before ssh is called', async () => {
    const capture = await runCaptured(signozCommand, ['logs', '--since', 'sometime', '--json'])
    expect(capture.code).toBe(2)
    expect(ssh.argv()).toHaveLength(0)
  })

  test('describe needs a table', async () => {
    const capture = await runCaptured(signozCommand, ['describe'])
    expect(capture.code).toBe(2)
    expect(ssh.argv()).toHaveLength(0)
  })

  test('an unknown target names the candidates', async () => {
    const capture = await runCaptured(signozCommand, ['databases', '--target', 'nope', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('config')
    expect(ssh.argv()).toHaveLength(0)
  })

})
