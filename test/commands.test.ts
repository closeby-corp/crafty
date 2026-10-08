import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import configCommand from '../src/commands/config.ts'
import doctorCommand from '../src/commands/doctor.ts'
import versionCommand from '../src/commands/version.ts'
import { loadCommands } from '../src/loader.ts'
import { configTemplate, resetConfigCache } from '../src/targets.ts'
import { join as joinPath } from 'node:path'
import { readVersion } from '../src/version.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { installFakeSsh, type FakeSsh } from './helpers/fake-ssh.ts'
import { startMockServer } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-commands-'))
let ssh: FakeSsh
let counter = 0

function tempFile(name: string, text: string): string {
  counter += 1
  const path = join(scratch, `${name}-${counter}.yml`)
  writeFileSync(path, text)
  return path
}

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

function rowsOf(capture: CliCapture): Record<string, unknown>[] {
  return envelope(capture)['data'] as Record<string, unknown>[]
}

beforeAll(async () => {
  ssh = installFakeSsh()
  await loadCommands()
})

afterAll(() => {
  ssh.restore()
  rmSync(scratch, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_OPS_CLI_TEST']
  resetConfigCache()
})

beforeEach(() => {
  ssh.reset()
})

describe('ops version', () => {
  test('reports the manifest version, in both modes', async () => {
    const expected = await readVersion()
    const json = await runCaptured(versionCommand, ['--json'])
    expect(json.code).toBe(0)
    const data = envelope(json)['data'] as Record<string, unknown>
    expect(data['version']).toBe(expected)
    expect(data['bun']).toBe(Bun.version)
    expect((JSON.parse(readFileSync(joinPath(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string }).version).toBe(
      expected,
    )

    const plain = await runCaptured(versionCommand, [])
    expect(plain.stdout).toStartWith(`${expected} (bun `)
  })
})

describe('ops config', () => {
  test('path resolves the file and says whether it is there', async () => {
    const path = tempFile('config', configTemplate())
    process.env['OPS_CONFIG'] = path
    resetConfigCache()
    const capture = await runCaptured(configCommand, ['path', '--json'])
    expect(envelope(capture)['data']).toEqual({ path, exists: true })

    process.env['OPS_CONFIG'] = join(scratch, 'absent.yml')
    resetConfigCache()
    const missing = await runCaptured(configCommand, ['path'])
    expect(missing.stdout).toContain('does not exist yet')
  })

  test('show lists settings, hosts and targets, with credentials only as sources', async () => {
    process.env['OPS_SECRET_OPS_CLI_TEST'] = 'hunter2'
    const path = tempFile(
      'show',
      [
        'settings:',
        '  max_rows: 5',
        '  data_dir: "~/.cache/ops-cli"',
        '  default_targets:',
        '    opensearch: os',
        'ssh:',
        '  hosts:',
        '    - uq-observability',
        'targets:',
        '  os:',
        '    kind: opensearch',
        '    base_url: "https://os.example.com"',
        '    auth: basic',
        '    username: ops',
        '    secret: ops-cli-test',
        '',
      ].join('\n'),
    )
    process.env['OPS_CONFIG'] = path
    resetConfigCache()

    const capture = await runCaptured(configCommand, ['show', '--json'])
    const data = envelope(capture)['data'] as Record<string, unknown>
    expect(data['path']).toBe(path)
    expect(data['settings']).toMatchObject({ max_rows: 5, timeout_ms: 15_000 })
    expect(data['ssh']).toEqual({ hosts: ['uq-observability'] })
    expect(data['targets']).toEqual([
      {
        name: 'os',
        kind: 'opensearch',
        endpoint: 'https://os.example.com',
        auth: 'basic as ops',
        secret: 'ops-cli-test',
        credential: 'env OPS_SECRET_OPS_CLI_TEST',
      },
    ])
    expect(JSON.stringify(data)).not.toContain('hunter2')

    const human = await runCaptured(configCommand, ['show'])
    expect(human.stdout).toContain('max_rows')
    expect(human.stdout).toContain('ssh hosts  uq-observability')
  })

  test('init writes the contract and refuses to clobber without --force', async () => {
    const path = join(scratch, 'init', 'config.yml')
    process.env['OPS_CONFIG'] = path
    resetConfigCache()

    const first = await runCaptured(configCommand, ['init'])
    expect(first.code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(configTemplate())
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const again = await runCaptured(configCommand, ['init', '--json'])
    expect(again.code).toBe(1)
    expect(errorOf(again)).toMatchObject({ kind: 'conflict' })

    const forced = await runCaptured(configCommand, ['init', '--force', '--json'])
    expect(forced.code).toBe(0)
    expect(envelope(forced)['data']).toEqual({ path, written: true })
  })
})

describe('ops doctor', () => {
  function configFor(lines: string[]): void {
    process.env['OPS_CONFIG'] = tempFile('doctor', lines.join('\n'))
    resetConfigCache()
  }

  test('reports one row per source, and exits 1 when one fails', async () => {
    const server = startMockServer([
      { path: '/_cluster/health', body: { status: 'green', cluster_name: 'staging' } },
      { path: '/api/health', status: 500, body: { message: 'boom' } },
    ])
    const closed = 'http://127.0.0.1:1'
    configFor([
      'ssh:',
      '  hosts:',
      '    - uq-observability',
      'targets:',
      '  os:',
      '    kind: opensearch',
      `    base_url: "${server.url}"`,
      '    auth: none',
      '  graf:',
      '    kind: grafana',
      `    base_url: "${server.url}"`,
      '    auth: none',
      '  down:',
      '    kind: prometheus',
      `    base_url: "${closed}"`,
      '    auth: none',
      '',
    ])

    const capture = await runCaptured(doctorCommand, ['--json'])
    expect(capture.code).toBe(1)
    const rows = rowsOf(capture)
    expect(rows.map((row) => [row['target'], row['status']])).toEqual([
      ['uq-observability', 'ok'],
      ['os', 'ok'],
      ['graf', 'error'],
      ['down', 'unreachable'],
    ])
    expect(String(rows[1]?.['detail'])).toContain('status green')
    expect(envelope(capture)['meta']).toMatchObject({ count: 4 })
  })

  test('a refused credential is reported as auth, not as a broken service', async () => {
    const server = startMockServer([{ path: '/rest/api/3/myself', status: 401, body: { errorMessages: ['nope'] } }])
    configFor([
      'targets:',
      '  jira:',
      '    kind: jira',
      `    base_url: "${server.url}"`,
      '    auth: basic',
      '    username: ops',
      '    secret: ops-cli-test',
      '',
    ])
    process.env['OPS_SECRET_OPS_CLI_TEST'] = 'hunter2'
    const capture = await runCaptured(doctorCommand, ['--json'])
    expect(rowsOf(capture)[0]).toMatchObject({ target: 'jira', status: 'auth' })
    expect(capture.code).toBe(1)
  })

  test('an ssh host that refuses the key is told apart from one that is down', async () => {
    ssh.exit(255)
    ssh.reply('', 'Permission denied (publickey).\n')
    configFor(['ssh:', '  hosts:', '    - uq-observability', ''])
    const capture = await runCaptured(doctorCommand, ['--json'])
    expect(rowsOf(capture)[0]).toMatchObject({ kind: 'ssh', status: 'auth' })
    expect(String(rowsOf(capture)[0]?.['detail'])).toContain('Permission denied')
  })

  test('--target narrows the probes, and an unknown name lists the candidates', async () => {
    configFor([
      'targets:',
      '  os:',
      '    kind: prometheus',
      '    base_url: "http://127.0.0.1:1"',
      '    auth: none',
      '  other:',
      '    kind: grafana',
      '    base_url: "http://127.0.0.1:1"',
      '    auth: none',
      '',
    ])
    const one = await runCaptured(doctorCommand, ['--target', 'os', '--json'])
    expect(rowsOf(one)).toHaveLength(1)
    expect(rowsOf(one)[0]?.['target']).toBe('os')

    const unknown = await runCaptured(doctorCommand, ['--target', 'nope', '--json'])
    expect(unknown.code).toBe(1)
    expect(errorOf(unknown)).toMatchObject({ kind: 'not-found' })
    expect(String(errorOf(unknown)['hint'])).toContain('os, other')
  })

  test('the human form summarises the run on stderr', async () => {
    const server = startMockServer([{ path: '/_cluster/health', body: { status: 'green' } }])
    configFor([
      'targets:',
      '  os:',
      '    kind: opensearch',
      `    base_url: "${server.url}"`,
      '    auth: none',
      '',
    ])
    const capture = await runCaptured(doctorCommand, [])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toContain('status green')
    expect(capture.stderr).toContain('1 probe(s): 1 ok')
  })
})
