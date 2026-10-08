import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeReply {
  stdout?: string
  stderr?: string
  exit?: number
}

export interface FakeSsh {
  /** Every `ssh` invocation's argv, in order (appends are atomic across processes). */
  argv(): string[][]
  /** The remote command the last invocation carried (everything after `--`). */
  lastRemoteArgv(): string[]
  /** Answers every command with this. */
  reply(stdout: string, stderr?: string): void
  /** Answers commands whose remote line contains `match` with this. */
  replyFor(match: string, reply: FakeReply): void
  exit(code: number): void
  reset(): void
  restore(): void
}

/** Appends its argv to a log, then answers from the rule files written by the test. */
const SCRIPT = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const argvFile = Bun.env['FAKE_SSH_ARGV_FILE']
const argv = Bun.argv.slice(2)
if (argvFile) appendFileSync(argvFile, JSON.stringify(argv) + '\\n')

const read = async (path) => (path ? await Bun.file(path).text().catch(() => '') : '')
const rules = JSON.parse((await read(Bun.env['FAKE_SSH_RULES_FILE'])) || '[]')
const remote = argv.join(' ')
const rule = rules.find((candidate) => remote.includes(candidate.match))

const stdout = rule ? (rule.stdout ?? '') : await read(Bun.env['FAKE_SSH_STDOUT_FILE'])
const stderr = rule ? (rule.stderr ?? '') : await read(Bun.env['FAKE_SSH_STDERR_FILE'])
if (stdout !== '') process.stdout.write(stdout)
if (stderr !== '') process.stderr.write(stderr)
process.exit(Number(rule?.exit ?? Bun.env['FAKE_SSH_EXIT'] ?? '0'))
`

/**
 * Replaces `ssh` on PATH with a script that answers from files. `exec` passes
 * `process.env` to the child, so mutating it here is what the CLI sees.
 */
export function installFakeSsh(): FakeSsh {
  const dir = mkdtempSync(join(tmpdir(), 'ops-fake-ssh-'))
  const binary = join(dir, 'ssh')
  const argvFile = join(dir, 'argv.log')
  const rulesFile = join(dir, 'rules.json')
  const originalPath = process.env['PATH'] ?? ''

  writeFileSync(binary, SCRIPT)
  chmodSync(binary, 0o755)
  writeFileSync(argvFile, '')
  writeFileSync(rulesFile, '[]')
  process.env['PATH'] = `${dir}:${originalPath}`
  process.env['FAKE_SSH_ARGV_FILE'] = argvFile
  process.env['FAKE_SSH_RULES_FILE'] = rulesFile

  const rules: Array<FakeReply & { match: string }> = []

  const argv = (): string[][] =>
    readFileSync(argvFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[])

  return {
    argv,
    lastRemoteArgv: () => {
      const last = argv().at(-1)
      if (last === undefined) return []
      return last.slice(last.indexOf('--') + 1)
    },
    reply: (stdout, stderr = '') => {
      writeFileSync(join(dir, 'stdout.txt'), stdout)
      writeFileSync(join(dir, 'stderr.txt'), stderr)
      process.env['FAKE_SSH_STDOUT_FILE'] = join(dir, 'stdout.txt')
      process.env['FAKE_SSH_STDERR_FILE'] = join(dir, 'stderr.txt')
    },
    replyFor: (match, reply) => {
      rules.push({ match, ...reply })
      writeFileSync(rulesFile, JSON.stringify(rules))
    },
    exit: (code) => {
      process.env['FAKE_SSH_EXIT'] = String(code)
    },
    reset: () => {
      rules.length = 0
      writeFileSync(rulesFile, '[]')
      writeFileSync(argvFile, '')
      delete process.env['FAKE_SSH_EXIT']
      process.env['FAKE_SSH_STDOUT_FILE'] = join(dir, 'stdout.txt')
      process.env['FAKE_SSH_STDERR_FILE'] = join(dir, 'stderr.txt')
      writeFileSync(join(dir, 'stdout.txt'), '')
      writeFileSync(join(dir, 'stderr.txt'), '')
    },
    restore: () => {
      process.env['PATH'] = originalPath
      for (const name of [
        'FAKE_SSH_ARGV_FILE',
        'FAKE_SSH_RULES_FILE',
        'FAKE_SSH_STDOUT_FILE',
        'FAKE_SSH_STDERR_FILE',
        'FAKE_SSH_EXIT',
      ]) {
        delete process.env[name]
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
