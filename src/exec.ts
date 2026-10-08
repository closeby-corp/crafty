/**
 * Running a local command - ssh, git, aws - with one timeout policy and one
 * failure vocabulary. `Bun.spawn` uses the environment Bun was started with
 * unless one is passed, so PATH exported by the operator in this process is
 * honoured explicitly.
 */
import { kindForSystemCode, OpsError, errorMessage } from './errors.ts'

export interface ExecOptions {
  stdin?: string
  timeoutMs?: number
  /** Return the result even when the command failed. */
  allowFailure?: boolean
  cwd?: string
}

export interface ExecResult {
  argv: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export const DEFAULT_EXEC_TIMEOUT_MS = 30_000

function start(argv: string[], options: ExecOptions) {
  try {
    return Bun.spawn(argv, {
      stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    throw new OpsError(`cannot run ${argv[0] ?? 'the command'}: ${errorMessage(error)}`, kindForSystemCode(code), {
      hint: code === 'ENOENT' ? `install ${argv[0] ?? 'it'}, or fix PATH` : undefined,
      cause: error,
    })
  }
}

export async function exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  const startedAt = Date.now()
  const child = start(argv, options)

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  // A command that ignores SIGTERM must not keep the CLI alive forever.
  const escalate = setTimeout(() => child.kill(9), timeoutMs + 2_000)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const durationMs = Date.now() - startedAt

    if (timedOut) {
      throw new OpsError(`${argv.join(' ')} timed out after ${timeoutMs}ms`, 'network', { status: 124 })
    }
    if (exitCode !== 0 && options.allowFailure !== true) {
      throw new OpsError(commandFailure(argv, exitCode, stderr), 'remote', { status: exitCode })
    }
    return { argv, exitCode, stdout, stderr, durationMs }
  } finally {
    clearTimeout(timer)
    clearTimeout(escalate)
  }
}

/** The last two kilobytes of stderr: the useful part of a failed command. */
export function commandFailure(argv: string[], exitCode: number, stderr: string): string {
  const tail = stderr.trim().slice(-2_048)
  const command = argv.length === 0 ? '(no command)' : argv.join(' ')
  return `${command} exited ${exitCode}${tail === '' ? '' : `: ${tail}`}`
}
