import { parseArgs } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { runCommand } from './command.ts'
import type { RegisteredCommand } from './command.ts'
import { OpsError, usageError } from './errors.ts'
import { reportFailure } from './output.ts'
import { setOutputSink as setInvocationOutputSink, writeError, writeOutput } from './io.ts'

export const PROGRAM = 'crafty'

/** Argument handling failed in a way the operator can fix. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export interface CompletionContext {
  /** Only words up to and including the cursor; executable is word zero. */
  words: readonly string[]
  index: number
  prefix: string
  /** Last complete --config/-c before the cursor, if supplied. */
  configPath: string | undefined
  params: Readonly<Record<string, string>>
}

export type CompletionProvider = (ctx: CompletionContext) => readonly string[] | Promise<readonly string[]>
export type ValueCompletion = readonly string[] | CompletionProvider

export interface OptionSpec {
  name: string
  type: 'boolean' | 'string'
  short?: string
  /** Permit this string option to appear more than once; values are exposed in `ctx.repeat`. */
  repeatable?: boolean
  /** Register supplied values for redaction and expose its spellings on the invocation context. */
  sensitive?: boolean
  /** Lazy client-owned values, explicit enums, or native filesystem completion. */
  completion?: 'file' | 'directory' | ValueCompletion
}

export type Values = Record<string, string | string[] | boolean | undefined>

export interface ParsedArgs {
  values: Values
  positionals: string[]
  /** Everything after the first standalone `--`, untouched. */
  tail: string[]
}

const HELP: OptionSpec = { name: 'help', type: 'boolean', short: 'h' }

interface CliConfigScope {
  configPath: string | undefined
}

const cliConfigScope = new AsyncLocalStorage<CliConfigScope>()
let configPathOverride: string | undefined

/** Run a CLI layer in a scoped config context, inheriting and restoring nested calls. */
export async function withCliConfigScope<T>(callback: () => Promise<T>): Promise<T> {
  const current = cliConfigScope.getStore()
  return await cliConfigScope.run({ configPath: current?.configPath }, callback)
}

/** Run an invocation with the selected client config captured by a host process. */
export async function withCliConfigPath<T>(path: string | undefined, callback: () => Promise<T>): Promise<T> {
  return await cliConfigScope.run({ configPath: path }, callback)
}

/** The `--config` path given on the command line, if any. */
export function configPathFromCli(): string | undefined {
  const scope = cliConfigScope.getStore()
  return scope ? scope.configPath : configPathOverride
}

function setConfigPathFromCli(path: string): void {
  const scope = cliConfigScope.getStore()
  if (scope) scope.configPath = path
  else configPathOverride = path
}

/**
 * Pulls the global options out of argv wherever they appear, so
 * `--config x check` and `check --config x` behave the same. The command sees
 * the argv without them.
 */
export function extractGlobalOptions(argv: string[]): string[] {
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--') {
      rest.push(...argv.slice(index))
      break
    }
    if (arg === '--config' || arg === '-c') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new CliError(`${arg} needs a path`)
      setConfigPathFromCli(value)
      index += 1
      continue
    }
    if (arg.startsWith('--config=')) {
      setConfigPathFromCli(arg.slice('--config='.length))
      continue
    }
    rest.push(arg)
  }
  return rest
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

export function parseCommandArgs(argv: string[], options: OptionSpec[] = []): ParsedArgs {
  // `parseArgs` consumes the `--` marker, which would make `ssh run host --
  // docker ps` indistinguishable from `ssh run host docker ps`. Split at the
  // first standalone `--` ourselves and hand the parser only the head.
  const separator = argv.indexOf('--')
  if (separator !== -1) {
    const tail = argv.slice(separator + 1)
    const head = parseCommandArgs(argv.slice(0, separator), options)
    return { values: head.values, positionals: head.positionals, tail }
  }

  const specs = [HELP, ...options]
  const config: Record<string, { type: 'boolean' | 'string'; short?: string }> = {}
  for (const option of specs) {
    config[option.name] = option.short ? { type: option.type, short: option.short } : { type: option.type }
  }

  try {
    const parsed = parseArgs({ args: argv, options: config, allowPositionals: true, strict: true, tokens: true })
    const seen = new Set<string>()
    for (const token of parsed.tokens) {
      if (token.kind !== 'option' || specs.find((option) => option.name === token.name)?.type !== 'string') continue
      if (seen.has(token.name)) throw new CliError(`--${token.name} may only be given once`)
      seen.add(token.name)
    }
    return { values: parsed.values as Values, positionals: parsed.positionals, tail: [] }
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error))
  }
}

export function flag(values: Values, name: string): boolean {
  return values[name] === true
}

export function option(values: Values, name: string): string | undefined {
  const value = values[name]
  if (Array.isArray(value)) throw new CliError(`--${name} may only be given once`)
  return typeof value === 'string' ? value : undefined
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

/**
 * Set the current invocation's sink, or the process fallback outside one.
 * Independent async invocations keep their output sinks isolated.
 */
export function setOutputSink(sink: ((text: string) => void) | null): ((text: string) => void) | null {
  return setInvocationOutputSink(sink)
}

export function write(text: string): void {
  writeOutput(text)
}

export function writeErr(text: string): void {
  writeError(text)
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

let registry: RegisteredCommand[] = []
let resolved = new Map<string, RegisteredCommand>()

/** Validate the complete replacement before changing the active registry. */
export function setCommands(commands: RegisteredCommand[]): void {
  const next = new Map<string, RegisteredCommand>()
  for (const command of commands) {
    for (const name of [command.name, ...(command.definition.aliases ?? [])]) {
      if (next.has(name)) throw new OpsError(`duplicate command name or alias \"${name}\"`, 'config', { source: 'commands' })
      next.set(name, command)
    }
  }
  registry = [...commands]
  resolved = next
}

export function commands(): RegisteredCommand[] {
  return [...registry].sort((a, b) => a.name.localeCompare(b.name))
}

export function resolveCommand(name: string): RegisteredCommand | undefined {
  return resolved.get(name)
}

export function usageText(program = PROGRAM): string {
  const available = commands()
  const width = Math.max(0, ...available.map((command) => command.name.length))
  const lines = [
    `${program} <command> [options]`,
    '',
    'Commands:',
    ...available.map((command) => `  ${command.name.padEnd(width)}  ${command.definition.summary ?? ''}`),
    '',
    'Global options:',
    '  -c, --config <path>  Read settings from this file instead of the default',
    '',
    `Run \`${program} <command> --help\` for the options of one command.`,
  ]
  return `${lines.join('\n')}\n`
}

/** Route the root word; all command parsing and lifecycle work uses runCommand. */
async function runInConfigScope(rawArgv: string[], program: string): Promise<number> {
  try {
    const [first, ...rest] = extractGlobalOptions(rawArgv)
    if (first === undefined) {
      write(usageText(program))
      return 0
    }
    if (first === 'help' || first === '--help' || first === '-h') {
      const target = rest[0]
      if (target === undefined) {
        write(usageText(program))
        return 0
      }
      const command = resolveCommand(target)
      if (!command) throw usageError(`unknown command \"${target}\"`)
      return await runCommand(command, ['--help', ...rest.slice(1)], program)
    }
    const command = resolveCommand(first)
    if (!command) throw usageError(`unknown command \"${first}\"`)
    return await runCommand(command, rest, program)
  } catch (error) {
    return reportFailure(error, { source: 'cli', path: program, usage: usageText(program).trimEnd().split('\n') }, null, rawArgv, program)
  }
}

export async function run(rawArgv: string[], program = PROGRAM): Promise<number> {
  return withCliConfigScope(() => runInConfigScope(rawArgv, program))
}
