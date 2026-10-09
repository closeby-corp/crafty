import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { commands, configPathFromCli, option, PROGRAM, withCliConfigPath, write, writeErr } from '../cli.ts'
import { FRAMEWORK_OPTIONS, runCommand } from '../command.ts'
import type { CommandModule, CommandNode, McpCommandPolicy, RegisteredCommand } from '../command.ts'
import type { OptionSpec } from '../cli.ts'
import { errorMessage, usageError } from '../errors.ts'
import { redactString, withIsolatedSecretScope } from '../log.ts'
import { withOutputSinks } from '../io.ts'
import { assertNoStaticRouteShadow } from './mcp-route-guard.ts'
import type { JsonSchemaType } from '@modelcontextprotocol/server'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
const MCP_PATH = '/mcp'
const MAX_STDOUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 128 * 1024
const TOOL_NAME_MAX_LENGTH = 64
const MAX_ARGUMENTS = 256
const MAX_VALUE_LENGTH = 64 * 1024
const MAX_TOOL_INPUT_BYTES = 4 * 1024 * 1024

const HIDDEN_OPTIONS = new Set(['config', 'format', 'help', 'json', 'no-color', 'verbose', 'yes'])

interface RouteSegment {
  key: string
  node: CommandNode
  parameter?: string
}

interface ToolRoute {
  command: RegisteredCommand
  segments: RouteSegment[]
  name: string
  title: string
  description: string
  options: OptionSpec[]
  explicitlyReadOnly: boolean
  requiresAuthorization: boolean
  requiresWrite: boolean
}

interface ToolArguments {
  params?: Record<string, string>
  args?: string[]
  tail?: string[]
  options?: Record<string, string | boolean | string[]>
}

interface BoundedText {
  parts: string[]
  bytes: number
  truncated: boolean
  limit: number
}

interface OriginRule {
  protocol: string
  hostname: string
  anyHostname: boolean
}

function appendBounded(output: BoundedText, text: string): void {
  if (output.truncated || text.length === 0) return
  const byteLength = Buffer.byteLength(text)
  const remaining = output.limit - output.bytes
  if (byteLength <= remaining) {
    output.parts.push(text)
    output.bytes += byteLength
    return
  }

  let low = 0
  let high = Math.min(text.length, remaining)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, middle)) <= remaining) low = middle
    else high = middle - 1
  }
  if (low > 0) {
    const prefix = text.slice(0, low)
    output.parts.push(prefix)
    output.bytes += Buffer.byteLength(prefix)
  }
  output.truncated = true
}

function readBounded(output: BoundedText): string {
  return `${output.parts.join('')}${output.truncated ? '\n[Crafty MCP output truncated]\n' : ''}`
}

function safeInputString(value: unknown, label: string, allowLeadingDash = true): string {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH || value.includes('\0')) {
    throw usageError(`${label} must be a string of at most ${MAX_VALUE_LENGTH} characters without NUL bytes`)
  }
  if (!allowLeadingDash && value.startsWith('-')) {
    throw usageError(`${label} cannot start with a dash; pass it in tail after -- if needed`)
  }
  return value
}

function selectedOptions(nodes: readonly CommandNode[]): OptionSpec[] {
  const options = new Map(FRAMEWORK_OPTIONS.map((option) => [option.name, option]))
  const legacyRepeatable = new Set<string>()
  for (const node of nodes) {
    for (const option of node.options ?? []) {
      const inherited = options.get(option.name)
      options.set(option.name, inherited ? {
        ...inherited,
        ...option,
        short: inherited.short ?? option.short,
        repeatable: inherited.repeatable || option.repeatable,
        sensitive: inherited.sensitive || option.sensitive,
      } : option)
    }
    for (const name of node.repeatable ?? []) legacyRepeatable.add(name)
  }
  return [...options.values()].map((option) => ({
    ...option,
    repeatable: option.repeatable || legacyRepeatable.has(option.name),
  }))
}

function slug(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return result || 'command'
}

function toolName(path: string): string {
  const suffix = createHash('sha256').update(path).digest('hex').slice(0, 16)
  const prefix = slug(path).slice(0, TOOL_NAME_MAX_LENGTH - suffix.length - 1).replace(/_+$/g, '') || 'cmd'
  return `${prefix}_${suffix}`
}

function routeLabel(command: RegisteredCommand, segments: readonly RouteSegment[]): string {
  return [command.name, ...segments.map((segment) => segment.parameter ? `<${segment.parameter}>` : segment.key)].join(' ')
}

function collectToolRoutes(program: string): ToolRoute[] {
  const routes: ToolRoute[] = []
  for (const command of commands()) {
    const visit = (node: CommandNode, segments: RouteSegment[], nodes: CommandNode[], policy: Set<McpCommandPolicy>): void => {
      if (node.mcp) policy = new Set([...policy, node.mcp])
      if (policy.has('hidden')) return
      const nextNodes = [...nodes, node]
      if (node.run) {
        const label = routeLabel(command, segments)
        const options = selectedOptions(nextNodes)
        const hasConfirmationOption = options.some((option) => option.name === 'yes')
        const requiresWrite = policy.has('write') || hasConfirmationOption
        const explicitlyReadOnly = policy.has('read') && !requiresWrite
        const requiresAuthorization = !explicitlyReadOnly
        const pathKey = `${program}/${[command.name, ...segments.map((segment) => segment.parameter ? `by-${segment.parameter}` : segment.key)].join('/')}`
        routes.push({
          command,
          segments,
          name: toolName(pathKey),
          title: `${program} ${label}`,
          description: `${node.summary ?? `Run ${program} ${label}`}${requiresWrite
            ? ' Requires server-side write authorization.'
            : requiresAuthorization ? ' Requires server-side authorization until this route is marked mcp: read.' : ''}`,
          options,
          explicitlyReadOnly,
          requiresAuthorization,
          requiresWrite,
        })
        return
      }
      for (const [key, child] of Object.entries(node.commands ?? {})) {
        const parameter = key.startsWith(':') ? key.slice(1) : undefined
        visit(child as CommandNode, [...segments, { key, node: child as CommandNode, ...(parameter ? { parameter } : {}) }], nextNodes, policy)
      }
    }
    visit(command.definition, [], [], new Set())
  }
  return routes
}

function textSchema(description: string, completion?: OptionSpec['completion'] | CommandNode['completion']): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'string', maxLength: MAX_VALUE_LENGTH, description }
  if (Array.isArray(completion)) schema.enum = [...completion]
  return schema
}

function toolInputSchema(route: ToolRoute): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  const parameters = route.segments.filter((segment) => segment.parameter)
  if (parameters.length) {
    const paramProperties: Record<string, unknown> = Object.create(null)
    for (const segment of parameters) {
      const name = segment.parameter!
      paramProperties[name] = textSchema(`Value for the :${name} route segment`, segment.node.completion)
      required.push(name)
    }
    properties.params = { type: 'object', properties: paramProperties, required, additionalProperties: false }
  }

  properties.args = {
    type: 'array',
    description: 'Positional arguments after the command route. Their names and cardinality are client-defined.',
    items: { type: 'string', maxLength: MAX_VALUE_LENGTH },
    maxItems: MAX_ARGUMENTS,
  }
  properties.tail = {
    type: 'array',
    description: 'Arguments passed after the CLI -- marker, preserving their order and contents.',
    items: { type: 'string', maxLength: MAX_VALUE_LENGTH },
    maxItems: MAX_ARGUMENTS,
  }

  const optionProperties: Record<string, unknown> = {}
  for (const option of route.options) {
    if (HIDDEN_OPTIONS.has(option.name) || option.sensitive) continue
    const hint = option.short ? `CLI option --${option.name} (-${option.short})` : `CLI option --${option.name}`
    const base = option.type === 'boolean'
      ? { type: 'boolean', description: hint }
      : textSchema(hint, option.completion)
    optionProperties[option.name] = option.repeatable
      ? { type: 'array', items: base, maxItems: MAX_ARGUMENTS, description: `${hint}, supplied zero or more times` }
      : base
  }
  if (Object.keys(optionProperties).length) {
    properties.options = { type: 'object', properties: optionProperties, additionalProperties: false }
  }

  const topRequired = parameters.length ? ['params'] : []
  return { type: 'object', properties, required: topRequired, additionalProperties: false }
}

function buildArgv(route: ToolRoute, input: ToolArguments, allowWrites: boolean): string[] {
  const optionValues = Object.values(input.options ?? {})
  const argumentCount = (input.params ? Object.keys(input.params).length : 0)
    + (input.args?.length ?? 0)
    + (input.tail?.length ?? 0)
    + optionValues.reduce((count, value) => count + (Array.isArray(value) ? value.length : 1), 0)
  if (argumentCount > MAX_ARGUMENTS) throw usageError(`tool input may contain at most ${MAX_ARGUMENTS} argument values`)
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_TOOL_INPUT_BYTES) {
    throw usageError(`tool input must be at most ${MAX_TOOL_INPUT_BYTES} bytes`)
  }

  const argv = [route.command.name]
  for (let index = 0; index < route.segments.length; index += 1) {
    const segment = route.segments[index]!
    if (segment.parameter) {
      const value = safeInputString(input.params?.[segment.parameter], `params.${segment.parameter}`, false)
      const parent = index === 0 ? route.command.definition : route.segments[index - 1]!.node
      assertNoStaticRouteShadow(parent, segment.parameter, value)
      argv.push(value)
    } else {
      argv.push(segment.key)
    }
  }

  for (const option of route.options) {
    if (HIDDEN_OPTIONS.has(option.name) || option.sensitive) continue
    const value = input.options?.[option.name]
    if (value === undefined || value === false) continue
    if (option.type === 'boolean') {
      if (value !== true) throw usageError(`options.${option.name} must be a boolean`)
      argv.push(`--${option.name}`)
    } else if (option.repeatable) {
      if (!Array.isArray(value)) throw usageError(`options.${option.name} must be an array of strings`)
      for (const item of value) argv.push(`--${option.name}=${safeInputString(item, `options.${option.name}`)}`)
    } else {
      if (Array.isArray(value) || typeof value !== 'string') throw usageError(`options.${option.name} must be a string`)
      argv.push(`--${option.name}=${safeInputString(value, `options.${option.name}`)}`)
    }
  }

  if (route.requiresWrite && allowWrites && route.options.some((option) => option.name === 'yes')) argv.push('--yes')
  for (const value of input.args ?? []) argv.push(safeInputString(value, 'args[]', false))
  argv.push('--json')
  if (input.tail?.length) argv.push('--', ...input.tail.map((value) => safeInputString(value, 'tail[]')))
  return argv
}

async function runTool(route: ToolRoute, input: ToolArguments, program: string, configPath: string | undefined, allowWrites: boolean) {
  return await withIsolatedSecretScope(async () => {
    if (route.requiresAuthorization && !allowWrites) {
      return {
        content: [{ type: 'text' as const, text: route.requiresWrite
          ? 'This command can change state. Set CRAFTY_MCP_ALLOW_WRITES=1 in the server environment to authorize MCP write commands.'
          : 'This command has no MCP read-only declaration. Mark it mcp: read if it only reads state, or set CRAFTY_MCP_ALLOW_WRITES=1 in the server environment to authorize unclassified MCP commands.' }],
        isError: true,
      }
    }

    const stdout: BoundedText = { parts: [], bytes: 0, truncated: false, limit: MAX_STDOUT_BYTES }
    const stderr: BoundedText = { parts: [], bytes: 0, truncated: false, limit: MAX_STDERR_BYTES }
    let exitCode = 1
    try {
      const argv = buildArgv(route, input, allowWrites)
      await withOutputSinks({
        stdout: (text) => appendBounded(stdout, text),
        stderr: (text) => appendBounded(stderr, text),
      }, async () => {
        await withCliConfigPath(configPath, async () => {
          exitCode = await runCommand(route.command, argv, program)
        })
      })
    } catch (error) {
      return { content: [{ type: 'text' as const, text: redactString(errorMessage(error)) }], isError: true }
    }

    let text = readBounded(stdout).trimEnd()
    if (stderr.parts.length) {
      const diagnostic = redactString(readBounded(stderr)).trimEnd()
      text = text ? `${text}\n\nDiagnostics:\n${diagnostic}` : diagnostic
    }
    if (!text) text = exitCode === 0 ? 'Command completed successfully.' : `Command exited with status ${exitCode}.`
    return { content: [{ type: 'text' as const, text: redactString(text) }], ...(exitCode === 0 ? {} : { isError: true }) }
  })
}

function loopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  const octets = normalized.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
}

function hostName(value: string): string {
  if (!value || /[\s/@?#]/.test(value)) throw usageError(`invalid host name "${value}"`)
  let parsed: URL
  try {
    parsed = new URL(`http://${value}`)
  } catch {
    throw usageError(`invalid host name "${value}"`)
  }
  if (parsed.port || parsed.pathname !== '/' || parsed.username || parsed.password) throw usageError(`host names must not include a port or path: "${value}"`)
  return parsed.hostname.toLowerCase()
}

function parseOriginRule(value: string): OriginRule {
  if (!value || value === 'null' || /[\s?#]/.test(value)) throw usageError(`invalid browser origin "${value}"`)
  const wildcard = /^(moz|chrome)-extension:\/\/\*$/i.exec(value)
  if (wildcard) return { protocol: `${wildcard[1]!.toLowerCase()}-extension:`, hostname: '*', anyHostname: true }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw usageError(`invalid browser origin "${value}"`)
  }
  const extensionOrigin = parsed.protocol === 'moz-extension:' || parsed.protocol === 'chrome-extension:'
  if (parsed.username || parsed.password || (parsed.pathname !== '/' && !(extensionOrigin && parsed.pathname === '')) || parsed.search || parsed.hash || !parsed.hostname) {
    throw usageError(`browser origins must be scheme and host only: "${value}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'moz-extension:' && parsed.protocol !== 'chrome-extension:') {
    throw usageError(`unsupported browser origin scheme in "${value}"`)
  }
  return { protocol: parsed.protocol, hostname: parsed.hostname.toLowerCase(), anyHostname: false }
}

function browserOriginAllowed(origin: string, localhostHosts: readonly string[], configured: readonly OriginRule[]): boolean {
  let requestOrigin: OriginRule
  try {
    requestOrigin = parseOriginRule(origin)
  } catch {
    return false
  }
  if (requestOrigin.anyHostname) return false
  const localWebOrigin = (requestOrigin.protocol === 'http:' || requestOrigin.protocol === 'https:')
    && localhostHosts.includes(requestOrigin.hostname)
  return localWebOrigin || configured.some((rule) => rule.protocol === requestOrigin.protocol
    && (rule.anyHostname || rule.hostname === requestOrigin.hostname))
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT
  if (!/^\d+$/.test(value)) throw usageError('--port must be an integer from 0 through 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw usageError('--port must be an integer from 0 through 65535')
  return port
}

function validBearerToken(value: string | undefined): value is string {
  return value !== undefined && value.length >= 32 && /^[A-Za-z0-9._~-]+$/.test(value)
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization')
  if (!header) return false
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim())
  if (!match) return false
  const provided = Buffer.from(match[1]!)
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers()
  headers.set('Vary', 'Origin')
  if (!origin) return headers
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, MCP-Session-Id, Mcp-Method, Mcp-Name')
  headers.set('Access-Control-Expose-Headers', 'MCP-Protocol-Version, MCP-Session-Id, Mcp-Method')
  headers.set('Vary', 'Origin')
  return headers
}

function addCors(response: Response, cors: Headers): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of cors) if (name.toLowerCase() !== 'vary') headers.set(name, value)
  const varyValues = new Set([
    ...(response.headers.get('Vary') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
    ...(cors.get('Vary') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean),
  ])
  if (varyValues.size) headers.set('Vary', [...varyValues].join(', '))
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function serve(ctx: Parameters<NonNullable<CommandNode['run']>>[0]): Promise<void> {
  if (ctx.positionals.length || ctx.tail.length) throw usageError(`${ctx.path} does not accept positional arguments or arguments after --`)
  const host = (ctx.values.host as string | undefined) ?? DEFAULT_HOST
  const port = parsePort(ctx.values.port as string | undefined)
  const allowedHostOption = ctx.repeat['allowed-host'] ?? []
  const allowedOriginOption = ctx.repeat['allowed-origin'] ?? []
  const certPath = option(ctx.values, 'tls-cert')
  const keyPath = option(ctx.values, 'tls-key')
  const isLoopback = loopbackHost(host)
  const token = process.env.CRAFTY_MCP_TOKEN
  if (token !== undefined && !validBearerToken(token)) {
    throw usageError('CRAFTY_MCP_TOKEN must contain at least 32 URL-safe characters')
  }
  if (!isLoopback && !token) {
    throw usageError('non-loopback MCP binding requires a strong CRAFTY_MCP_TOKEN bearer token')
  }
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw usageError('--tls-cert and --tls-key must be provided together')
  }
  if (!isLoopback && !certPath) {
    throw usageError('non-loopback MCP binding requires --tls-cert and --tls-key so bearer tokens are sent over HTTPS')
  }

  const sdk = await import('@modelcontextprotocol/server')
  const localhostOrigins = isLoopback ? sdk.localhostAllowedOrigins() : []
  const configuredOrigins = allowedOriginOption.map(parseOriginRule)
  const allowedHosts = [...new Set([
    ...(isLoopback ? sdk.localhostAllowedHostnames() : []),
    ...allowedHostOption.map(hostName),
  ])]
  if (!isLoopback && allowedHosts.length === 0) {
    throw usageError('non-loopback MCP binding requires at least one --allowed-host value for Host header validation')
  }
  const allowedOrigins = [...new Set([
    ...localhostOrigins,
    ...configuredOrigins.map((rule) => rule.anyHostname ? `${rule.protocol}//*` : rule.hostname),
  ])]

  const programSuffix = ' mcp serve'
  if (!ctx.path.endsWith(programSuffix)) throw new Error('MCP server must be registered as "mcp"')
  const program = ctx.path.slice(0, -programSuffix.length) || PROGRAM
  const configPath = configPathFromCli()
  const allowWrites = process.env.CRAFTY_MCP_ALLOW_WRITES === '1'
  const registered = collectToolRoutes(program)
  const tls = certPath && keyPath ? { cert: await readFile(certPath), key: await readFile(keyPath) } : undefined
  const handler = sdk.createMcpHandler(() => {
    const server = new sdk.McpServer({ name: `${program}-commands`, version: '1.0.0' })
    for (const route of registered) {
      server.registerTool(route.name, {
        title: route.title,
        description: route.description,
        inputSchema: sdk.fromJsonSchema<ToolArguments>(toolInputSchema(route) as JsonSchemaType),
        annotations: {
          ...(route.requiresWrite
            ? { readOnlyHint: false, destructiveHint: true }
            : route.explicitlyReadOnly
              ? { readOnlyHint: true, destructiveHint: false }
              : {}),
          openWorldHint: true,
        },
      }, async (input) => await runTool(route, input, program, configPath, allowWrites))
    }
    return server
  }, { maxRequestBodySize: MAX_TOOL_INPUT_BYTES + 64 * 1024 })

  const server = Bun.serve({
    hostname: host,
    port,
    maxRequestBodySize: MAX_TOOL_INPUT_BYTES + 64 * 1024,
    ...(tls ? { tls } : {}),
    async fetch(request) {
      const rejectedHost = sdk.hostHeaderValidationResponse(request, allowedHosts)
      if (rejectedHost) return rejectedHost
      const rejectedOrigin = sdk.originValidationResponse(request, allowedOrigins)
      if (rejectedOrigin) return rejectedOrigin
      const origin = request.headers.get('origin')
      if (origin && !browserOriginAllowed(origin, localhostOrigins, configuredOrigins)) {
        return new Response('Forbidden origin', { status: 403 })
      }
      const cors = corsHeaders(origin)
      if (new URL(request.url).pathname !== MCP_PATH) return addCors(new Response('Not found', { status: 404 }), cors)
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      if (token && !authorized(request, token)) {
        const headers = new Headers(cors)
        headers.set('WWW-Authenticate', 'Bearer')
        return new Response('Unauthorized', { status: 401, headers })
      }
      return addCors(await handler.fetch(request), cors)
    },
  })

  const wildcard = host === '0.0.0.0' || host === '::'
  const endpointHost = wildcard ? (allowedHostOption[0] ?? '127.0.0.1') : host
  const urlHost = endpointHost.includes(':') && !endpointHost.startsWith('[') ? `[${endpointHost}]` : endpointHost
  const protocol = tls ? 'https' : 'http'
  const bindHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const notice = `MCP server bound to ${bindHost}:${server.port}; connect at ${protocol}://${urlHost}:${server.port}${MCP_PATH}\nPress Ctrl-C to stop.\n`
  if (ctx.json) writeErr(notice)
  else write(notice)

  await new Promise<void>((resolve) => {
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      server.stop(true)
      void handler.close().then(resolve, resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/** Add the opt-in `mcp serve` command to a client command directory. */
export function createMcpPlugin(): CommandModule {
  return {
    name: 'mcp',
    summary: 'Serve configured Crafty commands over MCP',
    mcp: 'hidden',
    commands: {
      serve: {
        summary: 'Serve commands over MCP Streamable HTTP on /mcp',
        options: [
          { name: 'host', type: 'string' },
          { name: 'port', type: 'string' },
          { name: 'allowed-host', type: 'string', repeatable: true },
          { name: 'allowed-origin', type: 'string', repeatable: true },
          { name: 'tls-cert', type: 'string' },
          { name: 'tls-key', type: 'string' },
        ],
        async run(ctx) { await serve(ctx) },
      },
    },
  }
}
