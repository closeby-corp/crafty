/**
 * Direct VM access. Every remote source (docker, journald, ClickHouse over ssh)
 * goes through here, so quoting, timeouts and exit codes are decided once.
 */
import { readFileSync } from 'node:fs'
import { shellQuote } from './argv.ts'
import { kindForSystemCode, OpsError, errorMessage } from 'crafty'
import { DEFAULT_EXEC_TIMEOUT_MS, exec } from './exec.ts'
import { expandHome } from './targets.ts'

export interface SshHost {
  name: string
  host_name?: string
  user?: string
}

export interface SshRunOptions {
  stdin?: string
  timeoutMs?: number
  /** Return the result even when the remote command failed. */
  allowFailure?: boolean
}

export interface SshResult {
  host: string
  argv: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

/** BatchMode keeps ssh from prompting; a CLI that blocks on a password is useless. */
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new']

export async function sshRun(host: string, argv: string[], options: SshRunOptions = {}): Promise<SshResult> {
  // ssh joins everything after the host and re-parses it remotely, so the
  // command is quoted here and passed as one argument.
  const command = ['ssh', ...SSH_OPTIONS, host, '--', shellQuote(argv)]
  const result = await exec(command, {
    timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    allowFailure: options.allowFailure,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  }).catch((error: unknown) => {
    if (error instanceof OpsError && error.kind === 'config') {
      throw new OpsError(error.message, 'config', { hint: 'install openssh-client, or fix PATH', cause: error })
    }
    throw error
  })
  return {
    host,
    argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  }
}

/**
 * The `Host` lines of an ssh config, deduplicated and in file order. Patterns
 * (`*`, `?`, `!`) are skipped: they are not something you can ssh to.
 */
/**
 * Streaming needs the terminal, so it does not go through the buffered runner:
 * stdout is inherited, which also means Ctrl-C reaches ssh directly.
 */
export async function sshStream(host: string, argv: string[]): Promise<number> {
  const command = ['ssh', ...SSH_OPTIONS, host, '--', shellQuote(argv)]
  try {
    const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env })
    return await child.exited
  } catch (error) {
    const code = (error as { code?: string }).code
    throw new OpsError(`cannot run ssh: ${errorMessage(error)}`, kindForSystemCode(code), {
      hint: 'install openssh-client, or fix PATH',
      cause: error,
    })
  }
}

export function parseSshHosts(text: string): SshHost[] {
  const hosts: SshHost[] = []
  const byName = new Map<string, SshHost>()
  // Attributes belong to the block, so they land on the first host it declares.
  let block: SshHost | null = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]!.trim()
    if (line === '') continue
    const [keyword, ...rest] = line.split(/\s+/)
    if (keyword === undefined) continue

    if (keyword.toLowerCase() === 'host') {
      block = null
      for (const pattern of rest) {
        if (pattern === '' || /[*?!]/.test(pattern)) continue
        let host = byName.get(pattern)
        if (host === undefined) {
          host = { name: pattern }
          byName.set(pattern, host)
          hosts.push(host)
        }
        block ??= host
      }
      continue
    }
    if (block === null) continue
    const value = rest.join(' ')
    if (value === '') continue
    if (keyword.toLowerCase() === 'hostname') block.host_name ??= value
    else if (keyword.toLowerCase() === 'user') block.user ??= value
  }
  return hosts
}

export function listSshHosts(configPath = '~/.ssh/config'): SshHost[] {
  const path = expandHome(configPath)
  try {
    return parseSshHosts(readFileSync(path, 'utf8'))
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return []
    throw new OpsError(`cannot read ${path}: ${errorMessage(error)}`, 'config', { cause: error })
  }
}
