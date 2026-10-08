import type { Ctx, CommandInfo } from './output.ts'
import type { OptionSpec } from './cli.ts'
import { extractGlobalOptions, flag, parseCommandArgs, PROGRAM, setOutputSink, write, writeErr } from './cli.ts'
import { GLOBAL_OPTIONS, makeCtx, pullRepeatable, reportFailure } from './output.ts'
import { errorMessage, OpsError, usageError } from './errors.ts'
import { redactString } from './log.ts'

export type CommandHandler = (ctx: Ctx) => number | void | Promise<number | void>
export type CommandHook = (ctx: Ctx) => void | Promise<void>

export interface CommandNode {
  summary?: string
  usage?: string[]
  aliases?: string[]
  source?: string
  options?: OptionSpec[]
  repeatable?: string[]
  init?: CommandHook
  destroy?: CommandHook
  run?: CommandHandler
  commands?: Record<string, CommandNode | CommandHandler>
}

export interface CommandModule extends CommandNode {
  name?: string
}

export interface RegisteredCommand {
  name: string
  definition: CommandModule
  options: OptionSpec[]
  repeatable: string[]
}

export const FRAMEWORK_OPTIONS: OptionSpec[] = [
  ...GLOBAL_OPTIONS,
  { name: 'help', type: 'boolean', short: 'h' },
  { name: 'config', type: 'string', short: 'c', completion: 'file' },
]

function plainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function staticName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !/\s/.test(name) && !/^[-:]/.test(name)
}

/** Validate and normalize function children once, without changing the supplied module. */
export function prepareCommand(name: string, definition: CommandModule): RegisteredCommand {
  const fail = (message: string): never => { throw new OpsError(`${name}: ${message}`, 'internal') }
  if (!staticName(name) || name === 'help') fail('invalid or reserved root name')
  const options = new Map<string, OptionSpec>()
  const shorts = new Map<string, string>()
  const repeatable = new Set<string>()
  const active = new Set<CommandNode>()

  const addOption = (option: OptionSpec): void => {
    const existing = options.get(option.name)
    if (existing && existing.type !== option.type) fail(`conflicting types for --${option.name}`)
    if (existing?.short && option.short && existing.short !== option.short) fail(`conflicting short flags for --${option.name}`)
    if (option.short) {
      const owner = shorts.get(option.short)
      if (owner && owner !== option.name) fail(`-${option.short} is declared for --${owner} and --${option.name}`)
      shorts.set(option.short, option.name)
    }
    if (!existing || (!existing.short && option.short)) options.set(option.name, option)
  }
  FRAMEWORK_OPTIONS.forEach(addOption)

  const visit = (value: CommandNode | CommandHandler, parameters: Set<string>, dynamic: boolean, root = false): CommandNode => {
    if (typeof value === 'function') return { run: value }
    if (!plainObject(value)) fail('a command must be a plain object or child handler')
    if (active.has(value)) fail('recursive command object cycle')
    for (const hook of ['init', 'destroy', 'run'] as const) {
      if (value[hook] !== undefined && typeof value[hook] !== 'function') fail(`${hook} must be callable`)
    }
    const aliases = value.aliases ?? []
    if (!Array.isArray(aliases) || aliases.some((alias) => !staticName(alias) || (root && alias === 'help'))) fail('invalid or reserved alias')
    if (dynamic && aliases.length) fail('a parameter child cannot have aliases')
    if (value.commands !== undefined && !plainObject(value.commands)) fail('commands must be a plain object')
    const entries = Object.entries(value.commands ?? {})
    if (value.run !== undefined ? entries.length > 0 || value.commands !== undefined : entries.length === 0) {
      fail('a node must have either a handler or nonempty commands, not both')
    }
    for (const option of value.options ?? []) addOption(option)
    for (const option of value.repeatable ?? []) repeatable.add(option)
    active.add(value)
    const children: Record<string, CommandNode> = Object.create(null)
    const names = new Set<string>()
    let hasDynamic = false
    for (const [key, child] of entries) {
      const isDynamic = key.startsWith(':')
      let childParameters = parameters
      if (isDynamic) {
        const parameter = key.slice(1)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) fail(`invalid parameter ${key}`)
        if (hasDynamic) fail('only one parameter child is allowed per sibling set')
        if (parameters.has(parameter)) fail(`parameter ${key} repeats along a path`)
        hasDynamic = true
        childParameters = new Set(parameters)
        childParameters.add(parameter)
      } else if (!staticName(key)) fail(`invalid child name ${key}`)
      const node = visit(child, childParameters, isDynamic)
      if (!isDynamic) {
        for (const token of [key, ...(node.aliases ?? [])]) {
          if (names.has(token)) fail(`colliding child name or alias ${token}`)
          names.add(token)
        }
      }
      children[key] = node
    }
    active.delete(value)
    return entries.length ? { ...value, commands: children } : { ...value }
  }
  if (!plainObject(definition)) fail('the default export must be a plain command object')
  const normalized = visit(definition, new Set(), false, true)
  const rootNames = [name, ...(normalized.aliases ?? [])]
  if (new Set(rootNames).size !== rootNames.length) fail('colliding root name or aliases')
  return { name, definition: normalized, options: [...options.values()], repeatable: [...repeatable] }
}

function inheritedOptions(nodes: CommandNode[]): OptionSpec[] {
  const options = new Map(FRAMEWORK_OPTIONS.map((option) => [option.name, option]))
  for (const node of nodes) for (const option of node.options ?? []) options.set(option.name, option)
  return [...options.values()]
}

function usage(node: CommandNode, path: string, nodes: CommandNode[]): string[] {
  if (node.usage?.length) return node.usage
  const children = Object.entries(node.commands ?? {})
  const labels = children.map(([key]) => key.startsWith(':') ? `<${key.slice(1)}>` : key)
  const width = Math.max(0, ...labels.map((label) => label.length))
  return [
    `${path}${children.length ? ' <command>' : ''} [options]${children.length ? '' : ' [args...]'}`,
    ...(node.summary ? ['', node.summary] : []),
    ...(children.length ? ['', 'Commands:', ...children.map(([, child], index) => `  ${labels[index]!.padEnd(width)}  ${(child as CommandNode).summary ?? ''}`)] : []),
    '',
    'Options:',
    ...inheritedOptions(nodes).map((option) => `  ${option.short ? `-${option.short}, ` : ''}--${option.name}${option.type === 'string' ? ' <value>' : ''}`),
  ]
}

/** The only parser and lifecycle executor for direct invocations and recipe steps. */
export async function runCommand(command: RegisteredCommand, argv: string[], program = PROGRAM): Promise<number> {
  let node: CommandNode = command.definition
  const nodes: CommandNode[] = [node]
  let info: CommandInfo = {
    source: node.source ?? command.name,
    path: `${program} ${command.name}`,
    usage: usage(node, `${program} ${command.name}`, nodes),
  }
  let ctx: Ctx | null = null
  try {
    const { argv: head, repeat } = pullRepeatable(extractGlobalOptions(argv), command.repeatable)
    const parsed = parseCommandArgs(head, command.options)
    ctx = makeCtx(info, parsed, repeat)
    let index = 0
    while (node.commands) {
      const token = parsed.positionals[index]
      if (token === undefined) {
        if (flag(parsed.values, 'help')) break
        throw usageError('a subcommand is required', `commands: ${Object.keys(node.commands).join(', ')}`)
      }
      const entries = Object.entries(node.commands) as [string, CommandNode][]
      const selected = entries.find(([key, child]) => !key.startsWith(':') && (key === token || child.aliases?.includes(token)))
        ?? entries.find(([key]) => key.startsWith(':'))
      if (!selected) throw usageError(`unknown subcommand "${token}"`, `commands: ${Object.keys(node.commands).join(', ')}`)
      const [key, child] = selected
      if (key.startsWith(':')) ctx.params[key.slice(1)] = token
      node = child
      nodes.push(node)
      const path = `${info.path} ${key.startsWith(':') ? token : key}`
      info = { source: node.source ?? info.source, path, usage: usage(node, path, nodes) }
      ctx.source = info.source
      ctx.path = info.path
      ctx.usage = info.usage
      index += 1
    }
    ctx.positionals = parsed.positionals.slice(index)
    if (flag(parsed.values, 'help')) {
      write(`${info.usage.join('\n')}\n`)
      return 0
    }
  } catch (error) {
    return reportFailure(error, info, ctx, argv, program)
  }

  const entered: CommandNode[] = []
  const buffered: string[] = []
  const previousSink = ctx.json ? setOutputSink((text) => buffered.push(text)) : undefined
  let failed = false
  let failure: unknown
  let status = 0
  try {
    for (const selected of nodes) {
      entered.push(selected)
      await selected.init?.(ctx)
    }
    const result = await node.run!(ctx)
    if (result !== undefined) {
      if (!Number.isInteger(result) || result < 0 || result > 255) throw new OpsError('handler returned an invalid exit code', 'internal')
      status = result
    }
  } catch (error) {
    failed = true
    failure = error
  } finally {
    try {
      for (let index = entered.length - 1; index >= 0; index -= 1) {
        try {
          await entered[index]!.destroy?.(ctx)
        } catch (error) {
          if (failed || status !== 0) writeErr(`${redactString(errorMessage(error))}\n`)
          else {
            failed = true
            failure = new OpsError(redactString(errorMessage(error)), 'internal', { cause: error })
          }
        }
      }
    } finally {
      if (ctx.json) setOutputSink(previousSink!)
    }
  }
  if (failed) return reportFailure(failure, info, ctx, argv, program)
  if (ctx.json) for (const text of buffered) write(text)
  return status
}
