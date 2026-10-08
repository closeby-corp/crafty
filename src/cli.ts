import { parseArgs } from 'node:util'
import { runCommand } from './command.ts'
import type { RegisteredCommand } from './command.ts'
import { OpsError, usageError } from './errors.ts'
import { reportFailure } from './output.ts'

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

export interface OptionSpec {
  name: string
  type: 'boolean' | 'string'
  short?: string
}

export type Values = Record<string, string | string[] | boolean | undefined>

export interface ParsedArgs {
  values: Values
  positionals: string[]
  /** Everything after the first standalone `--`, untouched. */
  tail: string[]
}

const HELP: OptionSpec = { name: 'help', type: 'boolean', short: 'h' }

let configPathOverride: string | undefined

/** The `--config` path given on the command line, if any. */
export function configPathFromCli(): string | undefined {
  return configPathOverride
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
      configPathOverride = value
      index += 1
      continue
    }
    if (arg.startsWith('--config=')) {
      configPathOverride = arg.slice('--config='.length)
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

  // parseArgs keeps only the last value of a repeated single-value option, so
  // detect the repeat here instead of silently dropping what the operator typed.
  const shortNames = new Map(specs.flatMap((option) => (option.short ? [[option.short, option.name] as const] : [])))
  const seen = new Map<string, number>()
  for (const arg of argv) {
    const name = arg.startsWith('--')
      ? arg.slice(2).split('=')[0]
      : /^-[^-]$/.test(arg)
        ? shortNames.get(arg.slice(1))
        : undefined
    if (name === undefined) continue
    if (specs.find((option) => option.name === name)?.type !== 'string') continue
    const count = (seen.get(name) ?? 0) + 1
    if (count > 1) throw new CliError(`--${name} may only be given once`)
    seen.set(name, count)
  }

  try {
    const parsed = parseArgs({ args: argv, options: config, allowPositionals: true, strict: true })
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
 * Where `write` sends its text. The recipe engine swaps this for a capture
 * buffer so a step's output can be echoed, recorded and substituted without
 * spawning a second process; `null` restores stdout.
 */
let outputSink: ((text: string) => void) | null = null

/** Returns the sink that was in place, so a caller can restore it on the way out. */
export function setOutputSink(sink: ((text: string) => void) | null): ((text: string) => void) | null {
  const previous = outputSink
  outputSink = sink
  return previous
}

/** A closed pipe (`crafty ... | head`) is not a failure worth a stack trace. */
function onClosedPipe(error: unknown): boolean {
  return (error as { code?: string }).code === 'EPIPE'
}

export function write(text: string): void {
  if (outputSink) {
    outputSink(text)
    return
  }
  try {
    process.stdout.write(text)
  } catch (error) {
    if (!onClosedPipe(error)) throw error
  }
}

export function writeErr(text: string): void {
  try {
    process.stderr.write(text)
  } catch (error) {
    if (!onClosedPipe(error)) throw error
  }
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

export function usageText(): string {
  const available = commands()
  const width = Math.max(0, ...available.map((command) => command.name.length))
  const lines = [
    `${PROGRAM} <command> [options]`,
    '',
    'Commands:',
    ...available.map((command) => `  ${command.name.padEnd(width)}  ${command.definition.summary ?? ''}`),
    '',
    'Global options:',
    '  -c, --config <path>  Read settings from this file instead of the default',
    '',
    `Run \`${PROGRAM} <command> --help\` for the options of one command.`,
    `Run \`${PROGRAM} doctor\` to probe every configured source.`,
  ]
  return `${lines.join('\n')}\n`
}

/** Route the root word; all command parsing and lifecycle work uses runCommand. */
export async function run(rawArgv: string[]): Promise<number> {
  try {
    const [first, ...rest] = extractGlobalOptions(rawArgv)
    if (first === undefined) {
      write(usageText())
      return 0
    }
    if (first === 'help' || first === '--help' || first === '-h') {
      const target = rest[0]
      if (target === undefined) {
        write(usageText())
        return 0
      }
      const command = resolveCommand(target)
      if (!command) throw usageError(`unknown command \"${target}\"`)
      return await runCommand(command, ['--help', ...rest.slice(1)])
    }
    const command = resolveCommand(first)
    if (!command) throw usageError(`unknown command \"${first}\"`)
    return await runCommand(command, rest)
  } catch (error) {
    return reportFailure(error, { source: 'cli', path: PROGRAM, usage: usageText().trimEnd().split('\n') }, null, rawArgv)
  }
}
