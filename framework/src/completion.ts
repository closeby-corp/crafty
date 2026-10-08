import type { CompletionContext, OptionSpec } from './cli.ts'
import { FRAMEWORK_OPTIONS, type CommandNode, type RegisteredCommand } from './command.ts'

export interface CompletionResult {
  kind: 'values' | 'file' | 'directory'
  prefix: string
  replacementPrefix: string
  candidates: string[]
}

function values(prefix: string, candidates: readonly string[] = [], replacementPrefix = ''): CompletionResult {
  return { kind: 'values', prefix, replacementPrefix, candidates: [...new Set(candidates)].filter((value) => value.startsWith(prefix)).sort() }
}

async function optionValues(option: OptionSpec, ctx: CompletionContext, replacementPrefix = ''): Promise<CompletionResult> {
  if (option.completion === 'file' || option.completion === 'directory') {
    return { kind: option.completion, prefix: ctx.prefix, replacementPrefix, candidates: [] }
  }
  const candidates = typeof option.completion === 'function' ? await option.completion(ctx) : option.completion ?? []
  return values(ctx.prefix, candidates, replacementPrefix)
}

function childNode(child: CommandNode | NonNullable<CommandNode['run']>): CommandNode {
  return typeof child === 'function' ? { run: child } : child
}

function optionsFor(nodes: readonly CommandNode[]): OptionSpec[] {
  const options = new Map(FRAMEWORK_OPTIONS.map((option) => [option.name, option]))
  for (const node of nodes) for (const option of node.options ?? []) options.set(option.name, option)
  return [...options.values()]
}

interface OptionToken {
  option?: OptionSpec
  prefix?: string
  replacementPrefix?: string
  invalid?: boolean
}

/** Recognize the same long forms and boolean/string short clusters as parseArgs. */
function optionToken(token: string, options: readonly OptionSpec[]): OptionToken {
  if (token.startsWith('--')) {
    const equals = token.indexOf('=')
    const name = token.slice(2, equals === -1 ? undefined : equals)
    const option = options.find((candidate) => candidate.name === name)
    if (!option || (equals !== -1 && option.type === 'boolean')) return { invalid: true }
    return equals === -1
      ? { option }
      : { option, prefix: token.slice(equals + 1), replacementPrefix: token.slice(0, equals + 1) }
  }
  for (let index = 1; index < token.length; index += 1) {
    const option = options.find((candidate) => candidate.short === token[index])
    if (!option) return { invalid: true }
    if (option.type === 'string') {
      return index === token.length - 1
        ? { option }
        : { option, prefix: token.slice(index + 1), replacementPrefix: token.slice(0, index + 1) }
    }
  }
  return {}
}

/** Resolve declarations/providers only: never execute target handlers or hooks. */
export async function completeWords(registry: readonly RegisteredCommand[], words: readonly string[], index: number): Promise<CompletionResult> {
  const current = words[index] ?? ''
  if (!Number.isInteger(index) || index < 1 || index > words.length) return values(current)
  const head = words.slice(1, index)
  const config = FRAMEWORK_OPTIONS.find((option) => option.name === 'config')!
  const rootOptions = FRAMEWORK_OPTIONS.filter((option) => option.name === 'help' || option.name === 'config')
  const params: Record<string, string> = Object.create(null)
  let configPath: string | undefined
  const context = (prefix: string): CompletionContext => ({
    words: words.slice(0, index + 1), index, prefix, configPath, params,
  })

  // The root parser extracts config globally, even when it occurs between a
  // command option and its value. Preserve that precedence before routing.
  const tokens: string[] = []
  let configPending = false
  for (let position = 0; position < head.length; position += 1) {
    const token = head[position]!
    if (token === '--') return values(current)
    if (token === '--config' || token === '-c') {
      const next = head[position + 1]
      if (next === undefined) {
        configPending = true
        break
      }
      if (next.startsWith('-')) return values(current)
      configPath = next
      position += 1
    } else if (token.startsWith('--config=')) configPath = token.slice(9)
    else tokens.push(token)
  }

  // Repeatable long options are pulled before parseArgs, and can consume even
  // flag-looking values. They need not have a corresponding OptionSpec.
  const rootPosition = tokens[0] === 'help' || tokens[0] === '--help' || tokens[0] === '-h' ? 1 : 0
  const root = registry.find((entry) => entry.name === tokens[rootPosition] || entry.definition.aliases?.includes(tokens[rootPosition]!))
  let repeatPending: OptionSpec | undefined
  const routedTokens = tokens.slice(0, rootPosition + 1)
  for (let position = rootPosition + 1; position < tokens.length; position += 1) {
    const token = tokens[position]!
    const name = token.startsWith('--') ? token.slice(2).split('=')[0]! : ''
    if (!root?.repeatable.includes(name)) {
      routedTokens.push(token)
      continue
    }
    if (token.includes('=')) continue
    if (position + 1 === tokens.length) {
      repeatPending = { ...root.options.find((option) => option.name === name), name, type: 'string' }
      break
    }
    position += 1
  }

  let command: RegisteredCommand | undefined
  let node: CommandNode | undefined
  const nodes: CommandNode[] = []
  let help = false
  let pending: OptionSpec | undefined
  let invalid = false
  let union: readonly OptionSpec[] = rootOptions
  for (const token of routedTokens) {
    if (pending) {
      // Strict parseArgs rejects an ambiguous separate value beginning with '-'.
      if (token.startsWith('-')) { invalid = true; break }
      pending = undefined
      continue
    }
    if (!command) {
      if (!help && (token === 'help' || token === '--help' || token === '-h')) {
        help = true
        continue
      }
      command = registry.find((candidate) => candidate.name === token || candidate.definition.aliases?.includes(token))
      if (!command) { invalid = true; break }
      node = command.definition
      nodes.push(node)
      union = command.options
      continue
    }
    if (token.startsWith('-') && token !== '-') {
      const parsed = optionToken(token, union)
      if (parsed.invalid) { invalid = true; break }
      if (parsed.option?.type === 'string' && parsed.prefix === undefined) pending = parsed.option
      continue
    }
    if (!node?.commands) continue
    const entries = Object.entries(node.commands)
    const selected = entries.find(([name, child]) => !name.startsWith(':') && (name === token || childNode(child).aliases?.includes(token)))
      ?? entries.find(([name]) => name.startsWith(':'))
    if (!selected) { invalid = true; break }
    node = childNode(selected[1])
    if (selected[0].startsWith(':')) params[selected[0].slice(1)] = token
    nodes.push(node)
  }
  if (invalid) return values(current)
  const inherited = command ? optionsFor(nodes) : rootOptions
  // Route-local declarations override ancestors; the union still recognizes
  // descendant flags before their route has been reached.
  const selectedOption = (option: OptionSpec): OptionSpec => inherited.find((entry) => entry.name === option.name) ?? option
  if (configPending) return current.startsWith('-') ? values(current) : optionValues(config, context(current))
  if (current.startsWith('--config=')) return optionValues(config, context(current.slice(9)), '--config=')
  if (repeatPending) return optionValues(selectedOption(repeatPending), context(current))
  if (pending) return current.startsWith('-') ? values(current) : optionValues(selectedOption(pending), context(current))

  if (command && current.startsWith('--')) {
    const equals = current.indexOf('=')
    const name = current.slice(2, equals === -1 ? undefined : equals)
    if (equals !== -1 && command.repeatable.includes(name)) {
      const option: OptionSpec = { ...union.find((candidate) => candidate.name === name), name, type: 'string' }
      return optionValues(selectedOption(option), context(current.slice(equals + 1)), current.slice(0, equals + 1))
    }
  }
  if (current.startsWith('-') && current !== '-') {
    const parsed = optionToken(current, union)
    if (command && !parsed.invalid && parsed.option?.type === 'string') {
      if (parsed.prefix !== undefined) return optionValues(selectedOption(parsed.option), context(parsed.prefix), parsed.replacementPrefix)
      // A short string option may take its value in this very word; a long
      // option without '=' remains a flag until the next shell word.
      if (!current.startsWith('--')) return optionValues(selectedOption(parsed.option), context(''), current)
    }
    if (current.includes('=') || (!current.startsWith('--') && current.length > 2)) return values(current)
  }

  const candidates: string[] = []
  if (!command) {
    for (const entry of registry) candidates.push(entry.name, ...(entry.definition.aliases ?? []))
    if (!help) candidates.push('help')
  } else if (node?.commands) {
    for (const [name, child] of Object.entries(node.commands)) {
      if (name.startsWith(':')) {
        const completion = childNode(child).completion
        if (!current.startsWith('-') && completion) {
          candidates.push(...(typeof completion === 'function' ? await completion(context(current)) : completion))
        }
      } else candidates.push(name, ...(childNode(child).aliases ?? []))
    }
  }
  return values(current, candidates)
}
