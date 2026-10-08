import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote, splitArgv } from '../lib/argv.ts'
import sshCommand from '../commands/ssh.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { installFakeSsh, type FakeSsh } from './helpers/fake-ssh.ts'

let ssh: FakeSsh
const scratch = mkdtempSync(join(tmpdir(), 'ops-ssh-cmd-'))

const DOCKER_LOGS_OUT = [
  '2026-10-07T14:22:06.414696384Z starting signoz',
  '2026-10-07T14:22:07.000000000Z {"level":"ERROR","msg":"boom"}',
  '',
].join('\n')

/** docker logs splits the container's two streams; the reader has to re-merge them. */
const DOCKER_LOGS_ERR = [
  '2026-10-07T14:22:06.500000000Z the stderr side',
  '2026-10-07T14:22:08.000000000Z ERROR again from stderr',
  '',
].join('\n')

const UPTIME = ' 14:22:54 up 50 days, 14:00,  1 user,  load average: 0.49, 0.53, 0.54\n'
const FREE = [
  '               total        used        free      shared  buff/cache   available',
  'Mem:            7423        2898         797           4        4034        4524',
  'Swap:           4095         607        3488',
  '',
].join('\n')
const DF = [
  'Filesystem      Size  Used Avail Use% Mounted on',
  'tmpfs           1.5G  1.4M  1.5G   1% /run',
  '/dev/vda2       2.0G  190M  1.6G  11% /boot',
  '',
].join('\n')

/** health runs three commands at once, so the fake answers each one separately. */
function replyHealth(): void {
  ssh.replyFor('uptime', { stdout: UPTIME })
  ssh.replyFor('free', { stdout: FREE })
  ssh.replyFor('df', { stdout: DF })
}

beforeAll(() => {
  ssh = installFakeSsh()
})

afterAll(() => {
  ssh.restore()
  rmSync(scratch, { recursive: true, force: true })
})

/** The settings this suite needs, so it never reads the operator's own file. */
const SETTINGS_CONFIG = join(scratch, 'settings.yml')
writeFileSync(
  SETTINGS_CONFIG,
  ['settings:', '  timeout_ms: 15000', 'ssh:', '  hosts:', '    - uq-observability', '    - uq-ingress-controller', ''].join('\n'),
)

beforeEach(() => {
  ssh.reset()
  process.env['OPS_CONFIG'] = SETTINGS_CONFIG
  resetConfigCache()
})

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

/** The command the remote shell would run: the one quoted argument, unquoted. */
function remoteCommand(): string[] {
  return splitArgv(ssh.lastRemoteArgv()[0] ?? '')
}

describe('ops ssh ps', () => {
  test('asks docker for the three columns it renders', async () => {
    ssh.reply('signoz-signoz\tsignoz/signoz:v0.137.1\tUp 4 weeks\n')
    const capture = await runCaptured(sshCommand, ['ps', 'uq-observability', '--json'])
    expect(capture.code).toBe(0)
    expect(remoteCommand()).toEqual(['docker', 'ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'])
    expect(envelope(capture)['data']).toEqual([
      { host: 'uq-observability', name: 'signoz-signoz', image: 'signoz/signoz:v0.137.1', status: 'Up 4 weeks' },
    ])
  })

  test('--all adds the flag, and the table keeps the column order', async () => {
    ssh.reply('a\timg\tUp\nb\timg2\tExited\n')
    const capture = await runCaptured(sshCommand, ['ps', 'uq-observability', '--all'])
    expect(remoteCommand()).toContain('--all')
    const lines = capture.stdout.trimEnd().split('\n')
    expect(lines[0]?.split(/\s+/)).toEqual(['host', 'name', 'image', 'status'])
    expect(lines[1]?.split(/\s+/)).toEqual(['uq-observability', 'a', 'img', 'Up'])
    expect(lines[2]?.split(/\s+/)).toEqual(['uq-observability', 'b', 'img2', 'Exited'])
  })
})

describe('ops ssh df', () => {
  test('parses df -h, including a wrapped device name', async () => {
    ssh.reply(
      [
        'Filesystem                         Size  Used Avail Use% Mounted on',
        'tmpfs                              1.5G  1.4M  1.5G   1% /run',
        'overlay                            77G   16G   57G  22% /var/lib/docker/rootfs/overlay',
        '                                   fs/very/long/name',
        '/dev/vda2                          2.0G  190M  1.6G  11% /boot',
        '',
      ].join('\n'),
    )
    const capture = await runCaptured(sshCommand, ['df', 'uq-observability', '--json'])
    const rows = envelope(capture)['data'] as Record<string, string>[]
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({
      host: 'uq-observability',
      filesystem: 'tmpfs',
      size: '1.5G',
      used: '1.4M',
      avail: '1.5G',
      use_percent: '1%',
      mount: '/run',
    })
    expect(rows[1]?.['mount']).toBe('/var/lib/docker/rootfs/overlayfs/very/long/name')
    expect(rows[2]?.['mount']).toBe('/boot')
  })

  test('csv is the same rows, quoted', async () => {
    ssh.reply('Filesystem  Size  Used  Avail  Use%  Mounted on\n/dev/sda1   77G   16G   57G   22%  /\n')
    const capture = await runCaptured(sshCommand, ['df', 'uq-observability', '--format', 'csv'])
    expect(capture.stdout).toBe('host,filesystem,size,used,avail,use_percent,mount\r\nuq-observability,/dev/sda1,77G,16G,57G,22%,/\r\n')
  })
})

describe('ops ssh health', () => {
  test('merges uptime, free and df into one row', async () => {
    replyHealth()
    const capture = await runCaptured(sshCommand, ['health', 'uq-observability', '--json'])
    const data = envelope(capture)['data'] as Record<string, unknown>
    expect(data['host']).toBe('uq-observability')
    expect(data['uptime']).toBe('50 days, 14:00')
    expect(data['load']).toEqual({ '1m': 0.49, '5m': 0.53, '15m': 0.54 })
    expect(data['mem_total_mb']).toBe(7423)
    expect(data['mem_used_mb']).toBe(2898)
    expect((data['disks'] as Record<string, string>[]).map((disk) => disk['mount'])).toEqual(['/run', '/boot'])
  })

  test('runs three commands, in parallel, in one envelope', async () => {
    replyHealth()
    const capture = await runCaptured(sshCommand, ['health', 'uq-observability', '--json'])
    expect(capture.code).toBe(0)
    // The three run in parallel, so the order they arrive in is not the order asked for.
    expect(ssh.argv().map((argv) => splitArgv(argv.at(-1) ?? '')[0]).sort()).toEqual(['df', 'free', 'uptime'])
  })

  test('the human form is labelled lines, not one long JSON line', async () => {
    replyHealth()
    const capture = await runCaptured(sshCommand, ['health', 'uq-observability'])
    const lines = capture.stdout.trimEnd().split('\n')
    expect(lines[0]?.split(/\s+/)[0]).toBe('host')
    expect(lines).toContain('uptime        50 days, 14:00')
    expect(lines).toContain('disk  /run 1.4M/1.5G (1%)')
  })
})

describe('ops ssh logs', () => {
  test('merges the container stdout and stderr streams in time order', async () => {
    ssh.reply(DOCKER_LOGS_OUT, DOCKER_LOGS_ERR)
    const capture = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'signoz-signoz', '--json'])
    const rows = envelope(capture)['data'] as Record<string, string>[]
    expect(rows.map((row) => row['message'])).toEqual([
      'starting signoz',
      'the stderr side',
      '{"level":"ERROR","msg":"boom"}',
      'ERROR again from stderr',
    ])
    expect(rows[0]?.['ts']).toBe('2026-10-07T14:22:06.414Z')
    expect(rows[0]?.['raw']).toBe('2026-10-07T14:22:06.414696384Z starting signoz')
    expect(rows[0]?.['container']).toBe('signoz-signoz')
  })

  test('the docker window is passed through, because docker knows its own clock', async () => {
    ssh.reply('')
    await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'c', '--since', '10m', '--lines', '5', '--json'])
    expect(remoteCommand()).toEqual(['docker', 'logs', '--timestamps', '--since', '10m', '--tail', '5', 'c'])
  })

  test('--grep filters locally and case-insensitively', async () => {
    ssh.reply(DOCKER_LOGS_OUT, DOCKER_LOGS_ERR)
    const capture = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'c', '--grep', 'error'])
    expect(capture.stdout).toBe(
      [
        '2026-10-07T14:22:07.000000000Z {"level":"ERROR","msg":"boom"}',
        '2026-10-07T14:22:08.000000000Z ERROR again from stderr',
        '',
      ].join('\n'),
    )
  })

  test('--unit reads journald in short-iso, with an absolute window', async () => {
    ssh.reply('2026-10-07T14:25:02+00:00 uqcraft101 sshd[1]: accepted\n')
    const capture = await runCaptured(sshCommand, ['logs', 'uq-observability', '--unit', 'ssh', '--since', '30m', '--json'])
    const remote = remoteCommand()
    expect(remote.slice(0, 4)).toEqual(['journalctl', '-u', 'ssh', '--since'])
    expect(remote[4]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(remote).toContain('--no-pager')
    expect(remote).toContain('short-iso')
    expect(envelope(capture)['data']).toEqual([
      {
        host: 'uq-observability',
        unit: 'ssh',
        ts: '2026-10-07T14:25:02+00:00',
        message: 'uqcraft101 sshd[1]: accepted',
        raw: '2026-10-07T14:25:02+00:00 uqcraft101 sshd[1]: accepted',
      },
    ])
  })

  test('--file tails a path', async () => {
    ssh.reply('line one\nline two\n')
    const capture = await runCaptured(sshCommand, ['logs', 'uq-observability', '--file', '/etc/hostname', '--lines', '2', '--json'])
    expect(remoteCommand()).toEqual(['tail', '-n', '2', '/etc/hostname'])
    expect(envelope(capture)['data']).toEqual([
      { host: 'uq-observability', file: '/etc/hostname', message: 'line one', raw: 'line one' },
      { host: 'uq-observability', file: '/etc/hostname', message: 'line two', raw: 'line two' },
    ])
  })

  test('an odd --since is caught before anything is contacted', async () => {
    const capture = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'c', '--since', 'yesterday'])
    expect(capture.code).toBe(2)
    expect(capture.stderr).toContain('cannot read the time "yesterday"')
    expect(ssh.argv()).toHaveLength(0)
  })

  test('exactly one source is required', async () => {
    const none = await runCaptured(sshCommand, ['logs', 'uq-observability'])
    expect(none.code).toBe(2)
    expect(none.stderr).toContain('one of --container, --unit or --file is required')

    const both = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'a', '--unit', 'b'])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('give only one of --container, --unit or --file')

    const json = await runCaptured(sshCommand, ['logs', 'uq-observability', '--json'])
    expect(json.code).toBe(2)
    expect(errorOf(json)).toMatchObject({ kind: 'usage' })
  })

  test('--follow needs the terminal, so it refuses --json, --grep and --file', async () => {
    const followJson = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'c', '--follow', '--json'])
    expect(followJson.code).toBe(2)
    expect(errorOf(followJson)).toMatchObject({ kind: 'usage' })
    expect(String(errorOf(followJson)['message'])).toContain('cannot be combined with --json')

    const followGrep = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'c', '--follow', '--grep', 'x'])
    expect(followGrep.code).toBe(2)
    expect(followGrep.stderr).toContain('--grep filters in this process')

    const followFile = await runCaptured(sshCommand, ['logs', 'uq-observability', '--file', '/x', '--follow'])
    expect(followFile.code).toBe(2)
    expect(followFile.stderr).toContain('--follow needs --container or --unit')
  })

  test('an invalid --grep is a usage error, not a crash', async () => {
    const capture = await runCaptured(sshCommand, ['logs', 'uq-observability', '--container', 'c', '--grep', '('])
    expect(capture.code).toBe(2)
    expect(capture.stderr).toContain('--grep is not a valid regular expression')
  })
})

describe('ops ssh run', () => {
  test('echoes stdout, and hands the command over as its own arguments', async () => {
    ssh.reply('uqcraft101\n')
    const capture = await runCaptured(sshCommand, ['run', 'uq-observability', '--', 'hostname'])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toBe('uqcraft101\n')
    expect(remoteCommand()).toEqual(['hostname'])
  })

  test('a command with quoting survives the hop', async () => {
    ssh.reply('ok\n')
    await runCaptured(sshCommand, ['run', 'uq-observability', '--', 'docker', 'ps', '--format', '{{.Names}}'])
    expect(remoteCommand()).toEqual(['docker', 'ps', '--format', '{{.Names}}'])
    expect(ssh.lastRemoteArgv()).toEqual([shellQuote(['docker', 'ps', '--format', '{{.Names}}'])])
  })

  test('several hosts come back as rows, with the raw stdout', async () => {
    ssh.reply('uqcraft101\n')
    const capture = await runCaptured(sshCommand, ['run', 'a', 'b', '--json', '--', 'hostname'])
    const rows = envelope(capture)['data'] as Record<string, unknown>[]
    expect(rows.map((row) => row['host'])).toEqual(['a', 'b'])
    expect(rows[0]?.['stdout']).toBe('uqcraft101\n')
    expect(rows[0]?.['exit_code']).toBe(0)
    expect(envelope(capture)['meta']).toMatchObject({ count: 2 })
  })

  test('one host failing is a remote error carrying the exit code', async () => {
    ssh.reply('', 'bash: nope: command not found\n')
    ssh.exit(127)
    const capture = await runCaptured(sshCommand, ['run', 'uq-observability', '--json', '--', 'nope'])
    expect(capture.code).toBe(1)
    const error = errorOf(capture)
    expect(error).toMatchObject({ kind: 'remote', status: 127 })
    expect(String(error['message'])).toContain('command not found')
  })

  test('several hosts keep going when one fails, and the call exits 1', async () => {
    ssh.reply('out\n')
    ssh.exit(3)
    const capture = await runCaptured(sshCommand, ['run', 'a', 'b', '--json', '--', 'false'])
    expect(capture.code).toBe(1)
    const rows = envelope(capture)['data'] as Record<string, unknown>[]
    expect(rows.map((row) => row['exit_code'])).toEqual([3, 3])
    expect(ssh.argv()).toHaveLength(2)
  })

  test('hosts are labelled when there is more than one', async () => {
    ssh.reply('uqcraft101\n')
    const capture = await runCaptured(sshCommand, ['run', 'a', 'b', '--', 'hostname'])
    const lines = capture.stdout.split('\n')
    expect(lines[0]).toMatch(/^== a \(exit 0, [\d.]+m?s\)$/)
    expect(lines[1]).toBe('uqcraft101')
    expect(lines[2]).toMatch(/^== b \(exit 0, [\d.]+m?s\)$/)
    expect(lines[3]).toBe('uqcraft101')
  })

  test('the remote command is required, and --all excludes named hosts', async () => {
    const missing = await runCaptured(sshCommand, ['run', 'uq-observability'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('the remote command is required')

    const both = await runCaptured(sshCommand, ['run', 'uq-observability', '--all', '--', 'true'])
    expect(both.code).toBe(2)
    expect(both.stderr).toContain('give hosts or --all, not both')
  })

  test('--all reads [ssh].hosts from the configuration file', async () => {
    const configPath = join(scratch, 'config.yml')
    writeFileSync(configPath, ['ssh:', '  hosts:', '    - uq-observability', '    - uq-ingress-controller', ''].join('\n'))
    process.env['OPS_CONFIG'] = configPath
    resetConfigCache()
    ssh.reply('ok\n')
    const capture = await runCaptured(sshCommand, ['run', '--all', '--json', '--', 'hostname'])
    expect(capture.code).toBe(0)
    const rows = envelope(capture)['data'] as Record<string, unknown>[]
    expect(rows.map((row) => row['host'])).toEqual(['uq-observability', 'uq-ingress-controller'])
  })

  test('--parallel is clamped and --timeout is validated', async () => {
    ssh.reply('ok\n')
    const big = await runCaptured(sshCommand, ['run', 'a', '--parallel', '99', '--', 'true'])
    expect(big.code).toBe(0)

    const bogus = await runCaptured(sshCommand, ['run', 'a', '--timeout', 'soon', '--', 'true'])
    expect(bogus.code).toBe(2)
    expect(bogus.stderr).toContain('--timeout must be a positive number of seconds')
  })

  test('a verb that takes one host says so when it is given two', async () => {
    const capture = await runCaptured(sshCommand, ['df', 'a', 'b'])
    expect(capture.code).toBe(2)
  })
})

describe('ops ssh hosts and dispatch', () => {
  test('hosts lists ~/.ssh/config without contacting anything', async () => {
    const capture = await runCaptured(sshCommand, ['hosts', '--json'])
    const rows = envelope(capture)['data'] as Record<string, string>[]
    expect(rows.some((row) => row['name'] === 'uq-observability')).toBe(true)
    expect(ssh.argv()).toHaveLength(0)
  })

  test('unknown and incomplete routes are usage failures without transport', async () => {
    const unknown = await runCaptured(sshCommand, ['nope'])
    expect(unknown.code).toBe(2)

    const bare = await runCaptured(sshCommand, [])
    expect(bare.code).toBe(2)
    expect(ssh.argv()).toHaveLength(0)
  })

})
