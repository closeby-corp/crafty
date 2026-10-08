/**
 * `ops ssh`: what used to be hand-typed ssh + docker + journalctl, with one
 * option set and one JSON shape per row.
 */
import { existsSync } from 'node:fs'
import { configPathFromCli } from 'crafty'
import { ConfigError, OpsError, usageError } from 'crafty'
import { listSshHosts, sshRun, sshStream } from '../lib/ssh.ts'
import { loadConfig, resolveConfigPath, DEFAULT_SETTINGS } from '../lib/targets.ts'
import type { Settings } from '../lib/targets.ts'
import { emitResult, flag, intValue, option, plainText, required, write, writeErr } from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { formatDuration, parseSince } from '../lib/time.ts'

export interface HostRow {
  host: string
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
}

export interface LogRow {
  host: string
  container?: string
  unit?: string
  file?: string
  ts?: string
  message: string
  raw: string
}

export interface PsRow {
  host: string
  name: string
  image: string
  status: string
}

export interface DfRow {
  host?: string
  filesystem: string
  size: string
  used: string
  avail: string
  use_percent: string
  mount: string
}

export interface HealthRow {
  host: string
  uptime: string
  load: { '1m': number; '5m': number; '15m': number }
  mem_total_mb: number
  mem_used_mb: number
  disks: DfRow[]
}

/* ------------------------------------------------------------------ *
 * Parsing the remote output
 * ------------------------------------------------------------------ */

const DOCKER_TS = /^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\s?([\s\S]*)$/

/**
 * `docker logs` sends the container's stdout and stderr down two different
 * pipes, so reading the log as it happened means merging and reordering them.
 * Lines with no timestamp (a daemon error) keep their order at the end.
 */
export function mergeContainerStreams(stdout: string, stderr: string): string[] {
  const stamped: Array<{ line: string; at: number }> = []
  const plain: string[] = []
  for (const line of [...stderr.split('\n'), ...stdout.split('\n')]) {
    if (line === '') continue
    const token = DOCKER_TS.exec(line)?.[1]
    const at = token === undefined ? Number.NaN : Date.parse(token)
    if (Number.isNaN(at)) plain.push(line)
    else stamped.push({ line, at })
  }
  stamped.sort((left, right) => left.at - right.at)
  return [...stamped.map((entry) => entry.line), ...plain]
}

export function parseContainerLogs(lines: string[], host: string, container: string): LogRow[] {
  const rows: LogRow[] = []
  for (const raw of lines) {
    const match = DOCKER_TS.exec(raw)
    const stamp = match?.[1]
    const parsed = stamp === undefined ? Number.NaN : Date.parse(stamp)
    rows.push({
      host,
      container,
      ...(stamp === undefined ? {} : { ts: Number.isNaN(parsed) ? stamp : new Date(parsed).toISOString() }),
      message: match?.[2] ?? raw,
      raw,
    })
  }
  return rows
}

export function parseJournalLogs(stdout: string, host: string, unit: string): LogRow[] {
  const rows: LogRow[] = []
  for (const raw of stdout.split('\n')) {
    if (raw === '') continue
    const [, ts, rest] = /^(\S+) (.*)$/.exec(raw) ?? []
    rows.push({
      host,
      unit,
      ...(ts === undefined ? {} : { ts }),
      message: rest ?? raw,
      raw,
    })
  }
  return rows
}

export function parseFileLogs(stdout: string, host: string, file: string): LogRow[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((raw) => ({ host, file, message: raw, raw }))
}

export function parsePs(stdout: string, host: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const [name = '', image = '', status = ''] = line.split('\t')
    rows.push({ host, name, image, status })
  }
  return rows
}

/**
 * `df -h` columns, in order. A device name long enough to wrap leaves a short
 * line, whose remaining token is the mount point of the row before it.
 */
export function parseDf(stdout: string, host?: string): DfRow[] {
  const rows: DfRow[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '' || line.startsWith('Filesystem')) continue
    const fields = line.trim().split(/\s+/)
    if (fields.length < 6) {
      const previous = rows.at(-1)
      if (previous !== undefined && fields.length > 0) previous.mount += fields[0]!
      continue
    }
    rows.push({
      ...(host === undefined ? {} : { host }),
      filesystem: fields[0]!,
      size: fields[1]!,
      used: fields[2]!,
      avail: fields[3]!,
      use_percent: fields[4]!,
      mount: fields.slice(5).join(' '),
    })
  }
  return rows
}

export function parseUptime(stdout: string): { uptime: string; load: HealthRow['load'] } {
  const matched = /\bup\s+(.+?),\s+\d+\s+users?,\s+load average:\s*([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/.exec(stdout)
  const fallback = { uptime: stdout.trim(), load: { '1m': Number.NaN, '5m': Number.NaN, '15m': Number.NaN } }
  if (!matched) return fallback
  return {
    uptime: matched[1]!,
    load: { '1m': Number(matched[2]), '5m': Number(matched[3]), '15m': Number(matched[4]) },
  }
}

export function parseFree(stdout: string): { mem_total_mb: number; mem_used_mb: number } {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('Mem:')) continue
    const fields = line.trim().split(/\s+/)
    return { mem_total_mb: Number(fields[1]), mem_used_mb: Number(fields[2]) }
  }
  return { mem_total_mb: Number.NaN, mem_used_mb: Number.NaN }
}

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

/**
 * Settings without a configuration file are the defaults: a verb that only
 * needs ssh must work before `ops config init` has ever run.
 */
export function settingsOrDefaults(): Settings {
  const path = resolveConfigPath(process.env, configPathFromCli())
  if (existsSync(path)) return loadConfig().settings
  const explicit = configPathFromCli() ?? process.env['OPS_CONFIG']
  if (explicit !== undefined && explicit !== '') {
    throw new ConfigError([`there is no configuration file at ${path}`], path)
  }
  return { ...DEFAULT_SETTINGS }
}

export function timeoutMsFrom(ctx: Ctx, settings: Settings): number {
  const seconds = option(ctx.values, 'timeout')
  if (seconds === undefined) return settings.timeout_ms
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) throw usageError('--timeout must be a positive number of seconds')
  return Math.round(value * 1_000)
}

/** One ssh host, named on the command line and nothing else. */
function singleHost(ctx: Ctx): string {
  const host = ctx.positionals[0]
  if (host === undefined) throw usageError('a host is required', 'see `crafty ssh hosts` for the aliases in ~/.ssh/config')
  if (ctx.positionals.length > 1) {
    throw usageError(`this verb takes one host, got ${ctx.positionals.length}`, `did you mean \`crafty ssh run ${host} ${ctx.positionals[1]} -- <command>\`?`)
  }
  return host
}

/** Runs the same fn over items, at most `limit` at a time. */
export async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function grepPattern(ctx: Ctx): RegExp | null {
  const pattern = option(ctx.values, 'grep')
  if (pattern === undefined) return null
  try {
    // Case-insensitive, because a log line saying ERROR is still an error.
    return new RegExp(pattern, 'i')
  } catch (error) {
    throw usageError(`--grep is not a valid regular expression: ${(error as Error).message}`)
  }
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

const hostsVerb: CommandNode = { summary: 'List the aliases in ~/.ssh/config',
usage: [
  'crafty ssh hosts [options]',
  '',
  'Prints every `Host` name in ~/.ssh/config, with the HostName and User it',
  'resolves to. Wildcard patterns are skipped: they are not something you can',
  'ssh to. Nothing is contacted.',
  '',
  'Options:',
  '  --json      Print the envelope',
  '  --format    table, csv or json',
  '  -h, --help  Show this message',
],
run: async (ctx) => {
  const rows = listSshHosts().map((host) => ({
    name: host.name,
    ...(host.host_name === undefined ? {} : { host_name: host.host_name }),
    ...(host.user === undefined ? {} : { user: host.user }),
  }))
  emitResult(ctx, rows, { columns: ['name', 'host_name', 'user'], truncated: false })
  return 0
}, }

const runVerb: CommandNode = { summary: 'Run one command over ssh, on one or more hosts',
usage: [
  'crafty ssh run <host>... -- <command>... [options]',
  '',
  'Everything after `--` is the remote command; it is passed as separate',
  'arguments, so quoting survives both hops. Use `sh -c \'...\'` when the remote',
  'side needs pipes or redirection.',
  '',
  'One host fails, the whole call exits 1; with several hosts the per-host',
  'results are still printed. stdout is echoed as it came back.',
  '',
  'Options:',
  '  --all             Use the hosts listed under [ssh] in the config file',
  '  --parallel <n>    Hosts at a time, 1 to 8 (default 1)',
  '  --timeout <s>     Per-host timeout in seconds (default settings.timeout_ms)',
  '  --json            Print the envelope',
  '  -h, --help        Show this message',
],
options: [
  { name: 'all', type: 'boolean' },
  { name: 'parallel', type: 'string' },
  { name: 'timeout', type: 'string' },
],
run: async (ctx) => {
  if (ctx.tail.length === 0) {
    throw usageError('the remote command is required', 'pass it after `--`, as in `crafty ssh run uq-observability -- hostname`')
  }
  const useAll = flag(ctx.values, 'all')
  if (useAll && ctx.positionals.length > 0) {
    throw usageError('give hosts or --all, not both')
  }
  const settings = settingsOrDefaults()
  const hosts = useAll ? loadConfig().ssh.hosts : ctx.positionals
  if (hosts.length === 0) {
    throw usageError('at least one host is required', 'name a host, or list them under [ssh] in the config file and pass --all')
  }
  const parallel = intValue(ctx, 'parallel', 1, 1, 8)
  const timeoutMs = timeoutMsFrom(ctx, settings)

  const rows = await mapWithLimit(hosts, parallel, async (host) => {
    const result = await sshRun(host, ctx.tail, { timeoutMs, allowFailure: true })
    return {
      host,
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
    } satisfies HostRow
  })

  const failed = rows.filter((row) => row.exit_code !== 0)
  if (rows.length === 1 && failed.length === 1) {
    const only = failed[0]!
    throw new OpsError(`${only.host}: ${only.stderr.trim() === '' ? 'the command failed' : only.stderr.trim()}`, 'remote', {
      status: only.exit_code,
      target: only.host,
      hint: `the command ran: ${ctx.tail.join(' ')}`,
    })
  }

  if (ctx.json || ctx.format !== 'auto') {
    emitResult(ctx, rows, { columns: ['host', 'exit_code', 'stdout', 'stderr', 'duration_ms'], truncated: false })
  } else {
    for (const row of rows) {
      if (rows.length > 1) write(`== ${row.host} (exit ${row.exit_code}, ${formatDuration(row.duration_ms)})\n`)
      write(row.stdout)
      if (row.exit_code !== 0) writeErr(row.stderr)
    }
    if (failed.length > 0) writeErr(`${failed.length} of ${rows.length} host(s) failed: ${failed.map((row) => row.host).join(', ')}\n`)
  }
  return failed.length === 0 ? 0 : 1
}, }

const logsVerb: CommandNode = { summary: 'Docker, journald or file logs from one host',
usage: [
  'crafty ssh logs <host> (--container NAME | --unit NAME | --file PATH) [options]',
  '',
  'Reads one log source at a time, with the same window grammar every other',
  'log verb uses (`--since 90s`, `15m`, `12h`, `7d`, `2w`, an ISO timestamp).',
  'Docker timestamps are parsed into `ts`; every row keeps the raw line.',
  '',
  '--grep filters locally and case-insensitively. --follow streams to the',
  'terminal and cannot be combined with --json, --grep or --file: use',
  '`crafty ssh run <host> -- \'docker logs -f NAME | grep -i PATTERN\'` instead.',
  '',
  'Options:',
  '  --container <name>  Docker container logs',
  '  --unit <name>       journald unit logs',
  '  --file <path>       Last lines of a file (tail -n)',
  '  --since <when>      Start of the window (default 1h)',
  '  --lines <n>         Lines to fetch (default 200)',
  '  --grep <regex>      Keep only matching lines, case-insensitive',
  '  --follow            Keep streaming (human output only)',
  '  --timeout <s>       Timeout in seconds (default settings.timeout_ms)',
  '  --json              Print the envelope',
  '  -h, --help          Show this message',
],
options: [
  { name: 'container', type: 'string' },
  { name: 'unit', type: 'string' },
  { name: 'file', type: 'string' },
  { name: 'since', type: 'string' },
  { name: 'lines', type: 'string' },
  { name: 'grep', type: 'string' },
  { name: 'follow', type: 'boolean' },
  { name: 'timeout', type: 'string' },
],
run: async (ctx) => {
  const host = singleHost(ctx)
  const container = option(ctx.values, 'container')
  const unit = option(ctx.values, 'unit')
  const file = option(ctx.values, 'file')
  const chosen = [container, unit, file].filter((value) => value !== undefined)
  if (chosen.length !== 1) {
    throw usageError(
      chosen.length === 0 ? 'one of --container, --unit or --file is required' : 'give only one of --container, --unit or --file',
    )
  }

  const lines = intValue(ctx, 'lines', 200, 1, 100_000)
  const rawSince = option(ctx.values, 'since') ?? '1h'
  const since = parseSince(rawSince)
  const timeoutMs = timeoutMsFrom(ctx, settingsOrDefaults())

  if (flag(ctx.values, 'follow')) {
    if (ctx.json || ctx.format !== 'auto') throw usageError('--follow streams to the terminal, so it cannot be combined with --json or --format')
    if (file !== undefined) throw usageError('--follow needs --container or --unit', "for a file use `crafty ssh run <host> -- 'tail -f PATH'`")
    if (option(ctx.values, 'grep') !== undefined) {
      throw usageError('--grep filters in this process, which --follow cannot do', "use `crafty ssh run <host> -- 'docker logs -f NAME | grep -i PATTERN'` instead")
    }
    const argv =
      container === undefined
        ? ['journalctl', '-u', unit!, '--since', since.iso, '-n', String(lines), '--no-pager', '-o', 'short-iso', '-f']
        : ['docker', 'logs', '--timestamps', '--since', rawSince, '--tail', String(lines), '--follow', container]
    return await sshStream(host, argv)
  }

  if (container !== undefined) {
    const argv = ['docker', 'logs', '--timestamps', '--since', rawSince, '--tail', String(lines), container]
    const result = await sshRun(host, argv, { timeoutMs })
    const rows = parseContainerLogs(mergeContainerStreams(result.stdout, result.stderr), host, container)
    return emitLogs(ctx, rows, grepPattern(ctx), ['host', 'container', 'ts', 'message'])
  }

  if (unit !== undefined) {
    const argv = ['journalctl', '-u', unit, '--since', since.iso, '-n', String(lines), '--no-pager', '-o', 'short-iso']
    const result = await sshRun(host, argv, { timeoutMs })
    const rows = parseJournalLogs(result.stdout, host, unit)
    return emitLogs(ctx, rows, grepPattern(ctx), ['host', 'unit', 'ts', 'message'])
  }

  const argv = ['tail', '-n', String(lines), required(ctx, 'file')]
  const result = await sshRun(host, argv, { timeoutMs })
  const rows = parseFileLogs(result.stdout, host, file!)
  return emitLogs(ctx, rows, grepPattern(ctx), ['host', 'file', 'message'])
}, }

/** Logs read better as lines than as a table, unless a format was asked for. */
function emitLogs(ctx: Ctx, rows: LogRow[], grep: RegExp | null, columns: string[]): number {
  const kept = grep === null ? rows : rows.filter((row) => grep.test(row.raw))
  if (ctx.json || ctx.format !== 'auto') {
    emitResult(ctx, kept, { columns, truncated: false })
    return 0
  }
  if (kept.length === 0) writeErr(grep === null ? 'no log lines\n' : 'no log lines matched\n')
  for (const row of kept) write(`${row.raw}\n`)
  return 0
}

const psVerb: CommandNode = { summary: 'Containers on one host',
usage: [
  'crafty ssh ps <host> [options]',
  '',
  '`docker ps`, one row per container: name, image and status.',
  '',
  'Options:',
  '  --all       Include stopped containers',
  '  --timeout <s>  Timeout in seconds',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
options: [
  { name: 'all', type: 'boolean' },
  { name: 'timeout', type: 'string' },
],
run: async (ctx) => {
  const host = singleHost(ctx)
  const argv = [
    'docker',
    'ps',
    ...(flag(ctx.values, 'all') ? ['--all'] : []),
    '--format',
    '{{.Names}}\t{{.Image}}\t{{.Status}}',
  ]
  const result = await sshRun(host, argv, { timeoutMs: timeoutMsFrom(ctx, settingsOrDefaults()) })
  emitResult(ctx, parsePs(result.stdout, host), {
    columns: ['host', 'name', 'image', 'status'],
    truncated: false,
  })
  return 0
}, }

const dfVerb: CommandNode = { summary: 'Filesystem usage on one host',
usage: [
  'crafty ssh df <host> [options]',
  '',
  '`df -h`, one row per filesystem. Rows keep the strings df printed, so the',
  'percentages are never re-derived here.',
  '',
  'Options:',
  '  --timeout <s>  Timeout in seconds',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
options: [{ name: 'timeout', type: 'string' }],
run: async (ctx) => {
  const host = singleHost(ctx)
  const result = await sshRun(host, ['df', '-h'], { timeoutMs: timeoutMsFrom(ctx, settingsOrDefaults()) })
  emitResult(ctx, parseDf(result.stdout, host), {
    columns: ['host', 'filesystem', 'size', 'used', 'avail', 'use_percent', 'mount'],
    truncated: false,
  })
  return 0
}, }

const healthVerb: CommandNode = { summary: 'Load, memory and disks on one host',
usage: [
  'crafty ssh health <host> [options]',
  '',
  'Three remote commands (uptime, free -m, df -h) in one envelope, so a host',
  'can be triaged with a single call. Read-only.',
  '',
  'Options:',
  '  --timeout <s>  Timeout in seconds',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
options: [{ name: 'timeout', type: 'string' }],
run: async (ctx) => {
  const host = singleHost(ctx)
  const timeoutMs = timeoutMsFrom(ctx, settingsOrDefaults())
  const [uptime, free, df] = await Promise.all([
    sshRun(host, ['uptime'], { timeoutMs }),
    sshRun(host, ['free', '-m'], { timeoutMs }),
    sshRun(host, ['df', '-h'], { timeoutMs }),
  ])
  const { uptime: up, load } = parseUptime(uptime.stdout)
  const memory = parseFree(free.stdout)
  const row: HealthRow = { host, uptime: up, load, ...memory, disks: parseDf(df.stdout) }
  if (ctx.json || ctx.format !== 'auto') {
    emitResult(ctx, row, { truncated: false })
    return 0
  }
  write(plainText({ host, uptime: up, load: `${load['1m']}, ${load['5m']}, ${load['15m']}`, ...memory }))
  for (const disk of row.disks) write(`disk  ${disk.mount} ${disk.used}/${disk.size} (${disk.use_percent})\n`)
  return 0
}, }

export default {
  name: 'ssh',
  summary: 'Run commands and read logs on the infrastructure hosts over ssh',
  source: 'ssh',
  commands: {
    hosts: hostsVerb,
    run: runVerb,
    logs: logsVerb,
    ps: psVerb,
    df: dfVerb,
    health: healthVerb,
  },
} satisfies CommandModule
