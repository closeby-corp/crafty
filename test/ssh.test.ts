import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from '../src/argv.ts'
import { OpsError } from '../src/errors.ts'
import { listSshHosts, parseSshHosts, sshRun } from '../src/ssh.ts'

const dir = mkdtempSync(join(tmpdir(), 'ops-ssh-'))
const fake = join(dir, 'ssh')
const empty = join(dir, 'empty')
const originalPath = process.env['PATH'] ?? ''

/** A fake `ssh` that reports what it was handed, so quoting is testable. */
const FAKE = `#!/usr/bin/env bun
const args = Bun.argv.slice(2)
const stdin = await new Response(Bun.stdin.stream()).text()
const sleep = Number(Bun.env['FAKE_SSH_SLEEP'] ?? '0')
if (sleep > 0) await Bun.sleep(sleep)
console.error(Bun.env['FAKE_SSH_STDERR'] ?? '')
console.log(JSON.stringify({ argv: args, stdin }))
process.exit(Number(Bun.env['FAKE_SSH_EXIT'] ?? '0'))
`

beforeAll(() => {
  writeFileSync(fake, FAKE)
  chmodSync(fake, 0o755)
  require('node:fs').mkdirSync(empty, { recursive: true })
  process.env['PATH'] = `${dir}:${originalPath}`
})

afterAll(() => {
  process.env['PATH'] = originalPath
  rmSync(dir, { recursive: true, force: true })
})

function seen(stdout: string): { argv: string[]; stdin: string } {
  return JSON.parse(stdout) as { argv: string[]; stdin: string }
}

describe('sshRun', () => {
  test('quotes the remote command into one argument after --', async () => {
    const argv = ['docker', 'ps', '--format', '{{.Names}}\t{{.Image}}']
    const result = await sshRun('uq-observability', argv)
    const received = seen(result.stdout)

    expect(received.argv.slice(0, 3)).toEqual(['-o', 'BatchMode=yes', '-o'])
    expect(received.argv).toContain('StrictHostKeyChecking=accept-new')
    expect(received.argv.at(-3)).toBe('uq-observability')
    expect(received.argv.at(-2)).toBe('--')
    expect(received.argv.at(-1)).toBe(shellQuote(argv))
    expect(result.exitCode).toBe(0)
    expect(result.host).toBe('uq-observability')
    expect(result.argv).toEqual(argv)
  })

  test('passes stdin through, which is how SQL reaches clickhouse-client', async () => {
    const result = await sshRun('uq-observability', ['docker', 'exec', '-i', 'clickhouse'], {
      stdin: 'SELECT 1\n',
    })
    expect(seen(result.stdout).stdin).toBe('SELECT 1\n')
  })

  test('a non-zero exit is a remote error carrying the exit code and stderr tail', async () => {
    process.env['FAKE_SSH_EXIT'] = '3'
    process.env['FAKE_SSH_STDERR'] = 'bash: nope: command not found'
    try {
      await sshRun('uq-observability', ['nope'])
      throw new Error('expected OpsError')
    } catch (error) {
      expect(error).toBeInstanceOf(OpsError)
      expect((error as OpsError).kind).toBe('remote')
      expect((error as OpsError).status).toBe(3)
      expect((error as OpsError).message).toContain('command not found')
      expect((error as OpsError).message).toContain('exited 3')
    } finally {
      delete process.env['FAKE_SSH_EXIT']
      delete process.env['FAKE_SSH_STDERR']
    }
  })

  test('allowFailure hands the result back instead of throwing', async () => {
    process.env['FAKE_SSH_EXIT'] = '7'
    try {
      const result = await sshRun('uq-observability', ['false'], { allowFailure: true })
      expect(result.exitCode).toBe(7)
    } finally {
      delete process.env['FAKE_SSH_EXIT']
    }
  })

  // A real clock is unavoidable here: the delay lives inside the spawned fake
  // ssh, so fake timers in this process could never make it return, and the
  // kill is exactly what is being verified.
  test('a hung command is killed and reported as a timeout', async () => {
    process.env['FAKE_SSH_SLEEP'] = '10000'
    const startedAt = Date.now()
    try {
      await sshRun('uq-observability', ['sleep', '10'], { timeoutMs: 200 })
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('network')
      expect((error as OpsError).status).toBe(124)
      expect((error as OpsError).message).toContain('timed out after 200ms')
      expect(Date.now() - startedAt).toBeLessThan(3_000)
    } finally {
      delete process.env['FAKE_SSH_SLEEP']
    }
  })

  // Bun resolves an executable once per process, so emptying PATH here would
  // still find the real ssh. A child process with no cache is the only honest
  // way to reach the ENOENT branch.
  test('a missing ssh binary points at openssh-client', async () => {
    const script = [
      `import { sshRun } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'ssh.ts'))}`,
      'try {',
      "  await sshRun('uq-observability', ['hostname'])",
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
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    const reported = JSON.parse(stdout) as { kind: string; message: string; hint: string }
    expect(reported.kind).toBe('config')
    expect(reported.hint).toContain('openssh-client')
    expect(reported.message).toContain('cannot run ssh')
  })
})

describe('parseSshHosts', () => {
  test('keeps file order, drops patterns and duplicates, and reads HostName/User', () => {
    const text = [
      '# the support hosts',
      'Host uq-observability',
      '  HostName 10.0.0.1',
      '  User ubuntu',
      '',
      'Host *',
      '  ServerAliveInterval 30',
      '',
      'Host uq-ingress-controller uqcrafkube04',
      '  HostName 10.0.0.2',
      '',
      'Host uq-observability',
      '  User other',
      '',
      'Host !excluded uq-?.example.com',
    ].join('\n')
    expect(parseSshHosts(text)).toEqual([
      { name: 'uq-observability', host_name: '10.0.0.1', user: 'ubuntu' },
      { name: 'uq-ingress-controller', host_name: '10.0.0.2' },
      { name: 'uqcrafkube04' },
    ])
  })

  test('a config with no hosts is an empty list', () => {
    expect(parseSshHosts('')).toEqual([])
    expect(parseSshHosts('# nothing here\nInclude elsewhere\n')).toEqual([])
  })

  test('the real config parses, and a missing one is empty rather than fatal', () => {
    expect(listSshHosts().some((host) => host.name === 'uq-observability')).toBe(true)
    expect(listSshHosts('~/definitely-not-here')).toEqual([])
  })
})
