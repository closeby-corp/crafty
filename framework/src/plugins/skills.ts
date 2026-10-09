import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { flag, write, type OptionSpec } from '../cli.ts'
import type { CommandModule } from '../command.ts'
import { kindForSystemCode, OpsError, usageError } from '../errors.ts'
import { emitResult, type Ctx } from '../output.ts'
import { redactString } from '../log.ts'
import { listSkills, readSkill } from './skills-catalog.ts'

const INSTALLER = 'skills@1.7.1'
const MAX_CAPTURE = 1024 * 1024
const MAX_DIAGNOSTIC = 2_000
const INSTALL_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 2_000
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

type ChildResult = { code: number; stdout: string; stderr: string }

interface ChildOptions {
  cwd: string
  interactive: boolean
  timeoutMs?: number
}

interface InstallRecord {
  name: string
  status: 'installed'
  path?: string
  scope?: string
  agents?: string[]
  mode?: string
}

function sourcePath(source: string | URL): string {
  if (source instanceof URL) {
    if (source.protocol !== 'file:') throw new TypeError('skillsDir URL must use the file: protocol')
    return resolve(fileURLToPath(source))
  }
  return resolve(source)
}

function childRun(argv: string[], { cwd, interactive, timeoutMs }: ChildOptions): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['x', '--bun', INSTALLER, ...argv], {
      cwd,
      env: { ...process.env, INSTALL_INTERNAL_SKILLS: '0' },
      shell: false,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stopReason: 'output-limit' | 'timeout' | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (reason: 'output-limit' | 'timeout'): void => {
      if (stopReason) return
      stopReason = reason
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      forceKillTimer.unref?.()
    }
    const append = (current: string, chunk: unknown): string => {
      const next = current + String(chunk)
      if (Buffer.byteLength(next) > MAX_CAPTURE) {
        stop('output-limit')
        return next.slice(0, MAX_CAPTURE)
      }
      return next
    }
    if (!interactive) {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: unknown) => { stdout = append(stdout, chunk) })
      child.stderr?.on('data', (chunk: unknown) => { stderr = append(stderr, chunk) })
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => stop('timeout'), timeoutMs)
      timer.unref?.()
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      reject(new OpsError(`could not start the Skills installer: ${error.message}`, kindForSystemCode(error.code), {
        source: 'skills', target: cwd, cause: error,
        hint: 'Check that Bun is available and can run package executables.',
      }))
    })
    child.once('close', (code: number | null) => {
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (stopReason) {
        reject(new OpsError(
          stopReason === 'timeout' ? 'Skills installer timed out' : 'Skills installer exceeded its output limit',
          'upstream', { status: code ?? undefined, source: 'skills', target: cwd, hint: 'Retry with a smaller skill selection.' },
        ))
        return
      }
      resolvePromise({ code: code ?? 1, stdout, stderr })
    })
  })
}

function values(ctx: Ctx, name: string): string[] {
  const result = ctx.repeat[name] ?? []
  for (const value of result) {
    if (!value || value.startsWith('-') || value.includes('\0')) {
      throw usageError(`--${name} values must be non-empty names without a leading dash`)
    }
  }
  return result
}

function noExtraInput(ctx: Ctx): void {
  if (ctx.positionals.length || ctx.tail.length) throw usageError(`${ctx.path} does not accept positional arguments or arguments after --`)
}

function addArgv(source: string, skills: string[], agents: string[], ctx: Ctx, yes: boolean): string[] {
  const argv = ['add', source]
  for (const skill of skills) argv.push('--skill', skill)
  for (const agent of agents) argv.push('--agent', agent)
  if (flag(ctx.values, 'global')) argv.push('--global')
  if (flag(ctx.values, 'copy')) argv.push('--copy')
  if (yes) argv.push('--yes')
  return argv
}

function shortDiagnostic(value: string): string {
  const trimmed = redactString(value.trim())
  return trimmed.length > MAX_DIAGNOSTIC ? `${trimmed.slice(0, MAX_DIAGNOSTIC)}…` : trimmed
}

function verifyJsonInstall(result: ChildResult, skills: string[], target: string): InstallRecord[] {
  let records: unknown
  try {
    records = JSON.parse(result.stdout)
  } catch (cause) {
    throw new OpsError('Skills installer returned invalid JSON after exiting successfully', 'upstream', {
      source: 'skills', target, hint: shortDiagnostic(result.stderr) || 'Retry the installation and inspect the installer output.', cause,
    })
  }
  if (!Array.isArray(records)) {
    throw new OpsError('Skills installer returned an unexpected JSON result', 'upstream', { source: 'skills', target })
  }
  const installed: InstallRecord[] = []
  for (const skill of skills) {
    const record = records.find((item: unknown) => item !== null && typeof item === 'object' && (item as { name?: unknown }).name === skill) as ({ status?: unknown; error?: unknown; reason?: unknown } & Record<string, unknown>) | undefined
    if (record?.status !== 'installed') {
      const detail = typeof record?.error === 'string' ? record.error : typeof record?.reason === 'string' ? record.reason : undefined
      throw new OpsError(`Skills installer did not install "${skill}"${detail ? `: ${shortDiagnostic(detail)}` : ''}`, 'upstream', {
        status: 1, source: 'skills', target, hint: 'Review the installer result and retry the command.',
      })
    }
    installed.push({
      name: skill,
      status: 'installed',
      ...(typeof record.path === 'string' ? { path: record.path } : {}),
      ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
      ...(Array.isArray(record.agents) ? { agents: record.agents.filter((agent): agent is string => typeof agent === 'string') } : {}),
      ...(typeof record.mode === 'string' ? { mode: record.mode } : {}),
    })
  }
  return installed
}

function installFailure(result: ChildResult, target: string): OpsError {
  const diagnostic = shortDiagnostic(result.stderr || result.stdout)
  return new OpsError(
    `Skills installer failed with exit code ${result.code}${diagnostic ? `: ${diagnostic}` : ''}`,
    'upstream',
    { status: result.code, source: 'skills', target, hint: 'Review the installer diagnostic and retry the command.' },
  )
}

const options: OptionSpec[] = [
  { name: 'skill', type: 'string', repeatable: true },
  { name: 'agent', type: 'string', repeatable: true },
  { name: 'global', type: 'boolean' },
  { name: 'copy', type: 'boolean' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
]

/** Create a lazy local-skill catalog and installer command module. */
export function createSkillsPlugin({ skillsDir }: { skillsDir: string | URL }): CommandModule {
  // Resolve only the explicit configured source. Catalog IO remains invocation-local.
  const source = sourcePath(skillsDir)
  return {
    name: 'skills',
    summary: 'List, inspect, and install local agent skills',
    commands: {
      list: {
        summary: 'List skills available in the configured local catalog',
        mcp: 'read',
        async run(ctx) {
          noExtraInput(ctx)
          ctx.target = source
          const skills = await listSkills(source)
          if (ctx.json || ctx.format !== 'auto') emitResult(ctx, skills)
          else if (skills.length === 0) write('No skills found.\n')
          else write(skills.map(({ name, description }) => `${name}  ${description.replace(/\s+/g, ' ').trim()}`).join('\n') + '\n')
        },
      },
      show: {
        summary: 'Print one skill document',
        mcp: 'read',
        async run(ctx) {
          if (ctx.positionals.length !== 1 || ctx.tail.length) throw usageError(`${ctx.path} requires exactly one skill name and no arguments after --`)
          ctx.target = source
          const skill = await readSkill(source, ctx.positionals[0]!)
          if (ctx.json || ctx.format !== 'auto') emitResult(ctx, skill)
          else write(skill.content.endsWith('\n') ? skill.content : `${skill.content}\n`)
        },
      },
      install: {
        summary: 'Install selected local skills with the pinned Skills CLI',
        mcp: 'write',
        options,
        async run(ctx) {
          noExtraInput(ctx)
          const skillNames = values(ctx, 'skill')
          const agentNames = values(ctx, 'agent')
          const catalog = await listSkills(source)
          if (catalog.length === 0) throw new OpsError(`no installable skills found in ${source}`, 'not-found', { source: 'skills', target: source })
          const knownSkills = new Set(catalog.map((skill) => skill.name))
          for (const name of skillNames) if (!knownSkills.has(name)) throw usageError(`unknown skill "${name}"`, 'Run skills list to see available local skills.')
          for (const name of agentNames) {
            if (!SAFE_AGENT_ID.test(name) || name === '*') throw usageError(`invalid agent identifier "${name}"`)
          }

          const yes = flag(ctx.values, 'yes')
          const dryRun = flag(ctx.values, 'dry-run')
          const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !ctx.json && ctx.format === 'auto' && !yes
          if (!dryRun && !interactive && (!yes || skillNames.length === 0 || agentNames.length === 0)) {
            throw usageError('non-interactive skill installation requires --yes, at least one --skill, and at least one --agent')
          }

          const target = flag(ctx.values, 'global') ? 'global' : process.cwd()
          ctx.target = target
          const argv = addArgv(source, skillNames, agentNames, ctx, yes)
          if (dryRun) {
            const preview = { version: INSTALLER, source, target, skills: skillNames, agents: agentNames, argv: ['x', '--bun', INSTALLER, ...argv] }
            if (ctx.json) emitResult(ctx, preview)
            else write(`dry-run: install local skills\nsource  ${source}\ntarget  ${target}\nskills  ${skillNames.length ? skillNames.join(', ') : '(interactive selection)'}\nagents  ${agentNames.length ? agentNames.join(', ') : '(interactive selection)'}\ncommand ${preview.argv.map((part) => JSON.stringify(part)).join(' ')}\n`)
            return
          }

          if (!interactive) argv.push('--json')
          const result = await childRun(argv, {
            cwd: process.cwd(),
            interactive,
            ...(!interactive ? { timeoutMs: INSTALL_TIMEOUT_MS } : {}),
          })
          if (result.code !== 0) throw installFailure(result, target)
          const installed = interactive ? undefined : verifyJsonInstall(result, skillNames, target)
          const summary = { version: INSTALLER, source, target, skills: skillNames, agents: agentNames, exitCode: result.code, ...(installed ? { installed } : {}) }
          if (ctx.json) emitResult(ctx, summary)
          else if (!interactive) write(`Installed ${skillNames.join(', ')} for ${agentNames.join(', ')} in ${target}.\n`)
        },
      },
    },
  }
}
