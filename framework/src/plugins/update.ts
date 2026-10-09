import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flag, writeErr } from '../cli.ts'
import type { CommandModule, CommandStartupContext } from '../command.ts'
import { OpsError, usageError } from '../errors.ts'
import { emitResult, type Ctx } from '../output.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const STARTUP_TIMEOUT_MS = 3_000
const MANUAL_CHECK_TIMEOUT_MS = 15_000
const UPDATE_TIMEOUT_MS = 120_000
const MAX_CAPTURE = 256 * 1024
const KILL_GRACE_MS = 500

type ChildResult = { code: number; stdout: string; stderr: string }
interface TimeBudget { deadline: number }

interface RepoInfo {
  root: string
  branch: string
  head: string
  upstream: string
  remote: string
  remoteRef: string
  remoteBranch: string
  remoteUrl: string
  cacheFile: string
}

export interface UpdatePluginOptions {
  /** A directory inside the client CLI's Git repository. It is resolved at plugin creation time. */
  repositoryDir: string | URL
  /** How long to cache automatic update checks. Defaults to 24 hours. */
  checkIntervalMs?: number
  /** Disable startup notices while retaining the explicit `update` command. Defaults to true. */
  autoCheck?: boolean
  /** Override the user cache directory, mainly useful for clients with their own cache policy. */
  cacheDirectory?: string
}

export interface UpdateCheckResult {
  branch: string
  remote: string
  remoteBranch: string
  remoteAhead: number
  localAhead: number
  checkedVia: 'gh' | 'git'
}

function localPath(value: string | URL, label: string): string {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') throw new TypeError(`${label} URL must use the file: protocol`)
    return resolve(fileURLToPath(value))
  }
  return resolve(value)
}

function defaultCacheDirectory(): string {
  const configured = process.env.XDG_CACHE_HOME
  if (configured && isAbsolute(configured)) return join(configured, 'crafty', 'updates')
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local && isAbsolute(local)) return join(local, 'Crafty', 'Cache', 'updates')
    return join(homedir(), 'AppData', 'Local', 'Crafty', 'Cache', 'updates')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'Crafty', 'updates')
  return join(homedir(), '.cache', 'crafty', 'updates')
}

function cacheFileFor(repositoryDir: string, cacheDirectory: string): string {
  const key = createHash('sha256').update(repositoryDir).digest('hex')
  return join(cacheDirectory, `${key}.last-check`)
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  ]) delete env[key]
  return env
}

function timeBudget(timeoutMs: number): TimeBudget {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number')
  return { deadline: Date.now() + timeoutMs }
}

function remainingMs(budget: TimeBudget): number {
  const remaining = budget.deadline - Date.now()
  if (remaining <= 0) throw new Error('update check timed out')
  return remaining
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxCapture = MAX_CAPTURE,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stopReason: 'timeout' | 'output-limit' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = (error?: Error, result?: ChildResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (error) reject(error)
      else resolvePromise(result!)
    }
    const stop = (reason: 'timeout' | 'output-limit'): void => {
      if (stopReason) return
      stopReason = reason
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      forceKillTimer.unref?.()
    }
    const append = (current: string, chunk: unknown): string => {
      const next = current + String(chunk)
      if (Buffer.byteLength(next) > maxCapture) {
        stop('output-limit')
        return next.slice(0, maxCapture)
      }
      return next
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: unknown) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: unknown) => { stderr = append(stderr, chunk) })
    timer = setTimeout(() => stop('timeout'), timeoutMs)
    timer.unref?.()
    child.once('error', () => finish(new Error(`could not start ${executable}`)))
    child.once('close', (code: number | null) => {
      if (stopReason) {
        finish(new Error(stopReason === 'timeout' ? `${executable} timed out` : `${executable} output exceeded its limit`))
        return
      }
      finish(undefined, { code: code ?? 1, stdout, stderr })
    })
  })
}

async function runGit(args: string[], cwd: string, budget: TimeBudget): Promise<ChildResult> {
  return await runProcess('git', ['-C', cwd, ...args], cwd, remainingMs(budget), MAX_CAPTURE, gitEnvironment())
}

async function checkedGit(args: string[], cwd: string, budget: TimeBudget): Promise<string> {
  const result = await runGit(args, cwd, budget)
  if (result.code !== 0) throw new Error('Git command failed')
  return result.stdout.trimEnd()
}

async function inspectRepository(repositoryDir: string, cacheDirectory: string, budget: TimeBudget): Promise<RepoInfo> {
  const rootText = await checkedGit(['rev-parse', '--show-toplevel'], repositoryDir, budget)
  const root = resolve(rootText)
  const branch = await checkedGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, budget)
  if (!branch || branch.startsWith('-')) throw new Error('the current branch cannot be updated')

  const upstreamLine = await checkedGit([
    'for-each-ref',
    '--format=%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)',
    `refs/heads/${branch}`,
  ], root, budget)
  const [upstream, remote, remoteRef] = upstreamLine.split('\t')
  if (!upstream || !remote || !remoteRef?.startsWith('refs/heads/')) {
    throw new Error('the current branch has no configured upstream')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) throw new Error('the configured Git remote name is not supported')

  const head = await checkedGit(['rev-parse', 'HEAD'], root, budget)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error('Git returned an invalid commit id')
  const remoteUrl = await checkedGit(['remote', 'get-url', remote], root, budget)
  return {
    root,
    branch,
    head,
    upstream,
    remote,
    remoteRef: remoteRef!,
    remoteBranch: remoteRef.slice('refs/heads/'.length),
    remoteUrl,
    cacheFile: cacheFileFor(repositoryDir, cacheDirectory),
  }
}

function githubRepository(remoteUrl: string): { owner: string; repository: string } | undefined {
  let host: string | undefined
  let path: string | undefined
  if (/^[^/]+@github\.com:/i.test(remoteUrl)) {
    const match = /^[^/]+@github\.com:([^?#]+)$/i.exec(remoteUrl)
    host = 'github.com'
    path = match?.[1]
  } else {
    try {
      const url = new URL(remoteUrl)
      if (url.hostname.toLowerCase() === 'github.com' && ['https:', 'ssh:', 'git:'].includes(url.protocol)) {
        host = 'github.com'
        path = url.pathname
      }
    } catch {
      return undefined
    }
  }
  if (!host || !path) return undefined
  const parts = path.replace(/^\//, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2) return undefined
  let [owner, repository] = parts
  try {
    owner = decodeURIComponent(owner!)
    repository = decodeURIComponent(repository!)
  } catch {
    return undefined
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner!) || !/^[A-Za-z0-9_.-]+$/.test(repository!)) return undefined
  return { owner: owner!, repository: repository! }
}

function parseCounts(stdout: string): { localAhead: number; remoteAhead: number } {
  const [left, right] = stdout.trim().split(/\s+/).map(Number)
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left! < 0 || right! < 0) {
    throw new Error('Git returned invalid update counts')
  }
  return { localAhead: left!, remoteAhead: right! }
}

async function checkWithGh(info: RepoInfo, budget: TimeBudget): Promise<UpdateCheckResult | undefined> {
  const repo = githubRepository(info.remoteUrl)
  if (!repo) return undefined
  const endpoint = `repos/${repo.owner}/${repo.repository}/compare/${info.head}...${encodeURIComponent(info.remoteBranch)}`
  try {
    const result = await runProcess('gh', [
      'api', endpoint,
      '--hostname', 'github.com',
      '--jq', '{ahead_by: .ahead_by, behind_by: .behind_by}',
    ], info.root, remainingMs(budget), 16 * 1024)
    if (result.code !== 0) return undefined
    const value = JSON.parse(result.stdout) as { ahead_by?: unknown; behind_by?: unknown }
    const remoteAhead = value.ahead_by
    const localAhead = value.behind_by
    if (!Number.isSafeInteger(remoteAhead) || !Number.isSafeInteger(localAhead) ||
      (remoteAhead as number) < 0 || (localAhead as number) < 0) return undefined
    return {
      branch: info.branch,
      remote: info.remote,
      remoteBranch: info.remoteBranch,
      remoteAhead: remoteAhead as number,
      localAhead: localAhead as number,
      checkedVia: 'gh',
    }
  } catch {
    return undefined
  }
}

export async function checkForUpdates(
  repositoryDir: string | URL,
  options: { timeoutMs?: number; cacheDirectory?: string } = {},
): Promise<UpdateCheckResult> {
  const directory = localPath(repositoryDir, 'repositoryDir')
  const budget = timeBudget(options.timeoutMs ?? MANUAL_CHECK_TIMEOUT_MS)
  const cacheDirectory = localPath(options.cacheDirectory ?? defaultCacheDirectory(), 'cacheDirectory')
  const info = await inspectRepository(directory, cacheDirectory, budget)
  return await checkInfoForUpdates(info, budget)
}

async function checkInfoForUpdates(info: RepoInfo, budget: TimeBudget): Promise<UpdateCheckResult> {
  const ghResult = await checkWithGh(info, budget)
  if (ghResult) return ghResult

  const fetch = await runGit(['fetch', '--quiet', info.remote], info.root, budget)
  if (fetch.code !== 0) throw new Error('could not fetch the configured Git remote')
  const counts = parseCounts(await checkedGit(['rev-list', '--left-right', '--count', `HEAD...${info.upstream}`], info.root, budget))
  return {
    branch: info.branch,
    remote: info.remote,
    remoteBranch: info.remoteBranch,
    ...counts,
    checkedVia: 'git',
  }
}

async function cacheIsDue(path: string, intervalMs: number): Promise<boolean> {
  try {
    const previous = Number((await readFile(path, 'utf8')).trim())
    return !Number.isFinite(previous) || Date.now() - previous >= intervalMs || previous > Date.now()
  } catch {
    return true
  }
}

async function saveCheckTime(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${Date.now()}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function commandRoot(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--') return undefined
    if (token === '--config' || token === '-c' || token === '--format') {
      index += 1
      continue
    }
    if (token.startsWith('--config=') || token.startsWith('--format=')) continue
    if (token === '--json' || token === '--no-color' || token === '--verbose' || token === '-v' || token === '--help' || token === '-h') continue
    if (token.startsWith('-')) continue
    return token
  }
  return undefined
}

function mayNotify(ctx: CommandStartupContext): boolean {
  if (!ctx.interactive || ctx.argv.length === 0 || ctx.argv.some((arg) =>
    ['--json', '--help', '-h', '--format=json'].includes(arg))) return false
  for (let index = 0; index < ctx.argv.length; index += 1) {
    if (ctx.argv[index] === '--format' && ctx.argv[index + 1] === 'json') return false
  }
  const root = commandRoot(ctx.argv)
  return root !== undefined && root !== 'help' && root !== 'update' && root !== 'completion'
}

function availableMessage(program: string, result: UpdateCheckResult): string {
  const count = result.remoteAhead
  const commits = `${count} commit${count === 1 ? '' : 's'}`
  const divergence = result.localAhead > 0
    ? ` The local branch also has ${result.localAhead} unpushed commit${result.localAhead === 1 ? '' : 's'}, so update may need manual reconciliation.`
    : ''
  return `${program}: ${commits} available from ${result.remote}/${result.remoteBranch}; run \`${program} update\` to fast-forward.${divergence}\n`
}

async function handleStartup(
  repositoryDir: string,
  cacheDirectory: string,
  intervalMs: number,
  ctx: CommandStartupContext,
): Promise<void> {
  if (!mayNotify(ctx)) return
  try {
    const budget = timeBudget(STARTUP_TIMEOUT_MS)
    const info = await inspectRepository(repositoryDir, cacheDirectory, budget)
    if (!(await cacheIsDue(info.cacheFile, intervalMs))) return
    await saveCheckTime(info.cacheFile)
    const result = await checkInfoForUpdates(info, budget)
    if (result.remoteAhead > 0) writeErr(availableMessage(ctx.program, result))
  } catch {
    // Update checks are advisory: offline, unauthenticated, or unsupported repositories do not block commands.
  }
}

function requireNoExtraInput(ctx: Ctx): void {
  if (ctx.positionals.length || ctx.tail.length) throw usageError(`${ctx.path} does not accept positional arguments or arguments after --`)
}

function reportCheck(ctx: Ctx, result: UpdateCheckResult): void {
  const data = {
    ...result,
    updateAvailable: result.remoteAhead > 0,
    message: result.remoteAhead > 0
      ? availableMessage(ctx.path.split(' ')[0] ?? 'crafty', result).trimEnd()
      : 'Already up to date.',
  }
  if (ctx.json || ctx.format !== 'auto') emitResult(ctx, data)
  else writeErr(`${data.message}\n`)
}

/** Add `<cli> update` and a rate-limited, notification-only startup check. */
export function createUpdatePlugin(options: UpdatePluginOptions): CommandModule {
  const repositoryDir = localPath(options.repositoryDir, 'repositoryDir')
  const cacheDirectory = localPath(options.cacheDirectory ?? defaultCacheDirectory(), 'cacheDirectory')
  const intervalMs = options.checkIntervalMs ?? DAY_MS
  const autoCheck = options.autoCheck ?? true
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('checkIntervalMs must be a positive number')

  return {
    name: 'update',
    summary: 'Check for or fast-forward updates to this CLI repository',
    mcp: 'write',
    options: [{ name: 'check', type: 'boolean' }],
    onStart(ctx) {
      if (autoCheck) return handleStartup(repositoryDir, cacheDirectory, intervalMs, ctx)
    },
    async run(ctx) {
      requireNoExtraInput(ctx)
      try {
        if (flag(ctx.values, 'check')) {
          const result = await checkForUpdates(repositoryDir, { timeoutMs: MANUAL_CHECK_TIMEOUT_MS, cacheDirectory })
          reportCheck(ctx, result)
          return
        }

        const budget = timeBudget(UPDATE_TIMEOUT_MS)
        const info = await inspectRepository(repositoryDir, cacheDirectory, budget)
        const status = await checkedGit(['status', '--porcelain=v1', '--untracked-files=all'], info.root, budget)
        if (status) {
          throw new OpsError('Cannot update while the repository has local or untracked changes. Commit or stash them, then retry.', 'config', { source: 'update' })
        }
        const before = info.head
        const pull = await runGit(['pull', '--ff-only', '--quiet', info.remote, info.remoteRef], info.root, budget)
        if (pull.code !== 0) {
          throw new OpsError('Git could not fast-forward this branch. Check its upstream and local history, then reconcile it manually.', 'upstream', { source: 'update' })
        }
        const after = await checkedGit(['rev-parse', 'HEAD'], info.root, budget)
        if (before === after) {
          if (ctx.json || ctx.format !== 'auto') emitResult(ctx, { updated: false, head: after, branch: info.branch })
          else writeErr('Already up to date.\n')
          return
        }
        const result = { updated: true, previousHead: before, head: after, branch: info.branch }
        if (ctx.json || ctx.format !== 'auto') emitResult(ctx, result)
        else writeErr(`Updated ${info.branch}. Restart ${ctx.path.split(' ')[0] ?? 'this CLI'} to load the new version. If dependencies changed, run bun install first.\n`)
      } catch (error) {
        if (error instanceof OpsError) throw error
        throw new OpsError('Unable to update this CLI. Confirm the configured repository, Git access, and upstream branch.', 'upstream', {
          source: 'update',
          cause: error,
        })
      }
    },
  }
}

export default createUpdatePlugin
