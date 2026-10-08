/**
 * `ops config`: where settings come from, what is in them, and how to start a
 * file. Every value is shown with the file it came from, never redacted except
 * the credentials themselves - which are only ever reported as stored or not.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configPathFromCli } from 'crafty'
import { errorMessage, OpsError } from 'crafty'
import { emitResult, flag, write, writeErr } from 'crafty'
import type { CommandNode, CommandModule } from 'crafty'
import { targetCredential } from '../lib/secrets.ts'
import { configTemplate, loadConfig, resolveConfigPath, type Target, type TargetFile } from '../lib/targets.ts'

export interface TargetRow {
  name: string
  kind: string
  endpoint: string
  auth: string
  /** The `secret:` key it names, which is the variable that may hold it. */
  secret: string
  /** Where the credential comes from: `env <VAR>`, `file`, or `none`. */
  credential: string
}

/** Where a target is reached and how it authenticates, in one line. */
export function describeTarget(target: Target): { endpoint: string; auth: string; secret: string } {
  switch (target.kind) {
    case 'signoz':
      return {
        endpoint: `ssh ${target.ssh_host} -> docker exec ${target.container} (${target.database})`,
        auth: 'ssh',
        secret: '-',
      }
    case 'db': {
      const names = Object.keys(target.databases)
      return {
        endpoint: `${names.length} database(s): ${names.join(', ')}`,
        auth: 'the connector strings themselves',
        secret: '-',
      }
    }
    default: {
      const http = target as { base_url: string; auth: string; secret?: string; username?: string; workspace?: string }
      const scope = target.kind === 'bitbucket' ? ` (${target.workspace})` : ''
      const key = 'secret' in target ? target.secret : undefined
      const inline = 'password' in target && target.password !== undefined ? target.password : 'token' in target ? target.token : undefined
      return {
        endpoint: `${http.base_url}${scope}`,
        auth: http.username === undefined ? http.auth : `${http.auth} as ${http.username}`,
        secret: key ?? (inline === undefined ? '-' : 'written in the file'),
      }
    }
  }
}

async function rowsFor(file: TargetFile): Promise<TargetRow[]> {
  const rows: TargetRow[] = []
  for (const target of [...file.targets.values()]) {
    const described = describeTarget(target)
    // Where the credential actually comes from: the file itself, the
    // environment, or the store the `secret` key names.
    const credential = targetCredential(target.kind, {
      ...('secret' in target && target.secret !== undefined ? { secret: target.secret } : {}),
      ...('password' in target && target.password !== undefined ? { password: target.password } : {}),
      ...('token' in target && target.token !== undefined ? { token: target.token } : {}),
    })
    // Where the credential actually comes from, in the order it is resolved. A
    // db target holds its databases' credentials inside its connector strings,
    // so those live in this file whatever the resolver says about the target.
    const source =
      target.kind === 'db'
        ? 'file'
        : credential === null
        ? 'none'
        : credential.source === 'config'
          ? 'file'
          : `env${credential.from === undefined ? '' : ` ${credential.from}`}`
    rows.push({
      name: target.name,
      kind: target.kind,
      endpoint: described.endpoint,
      auth: described.auth,
      secret: described.secret,
      credential: source,
    })
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

export function resolvedConfigPath(): string {
  return resolveConfigPath(process.env, configPathFromCli())
}

const pathVerb: CommandNode = { summary: 'Print the configuration file this process would read',
usage: [
  'crafty config path [options]',
  '',
  'The resolution order is --config, then $OPS_CONFIG, then',
  '$XDG_CONFIG_HOME/ops-cli/config.yml, then ~/.config/ops-cli/config.yml.',
  'Nothing is read here: the file may not exist yet.',
  '',
  'Options:',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
run: async (ctx) => {
  const path = resolvedConfigPath()
  const exists = existsSync(path)
  if (ctx.json) {
    emitResult(ctx, { path, exists }, { truncated: false })
    return 0
  }
  write(`${path}${exists ? '' : '  (does not exist yet; run `crafty config init`)'}\n`)
  return 0
}, }

const showVerb: CommandNode = { summary: 'Show the settings and targets in force, credentials redacted',
usage: [
  'crafty config show [options]',
  '',
  'Every setting and target the commands will use, with the file they came',
  'from: `env <VAR>`, `file` or `none` - never the value itself.',
  '',
  'Options:',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
run: async (ctx) => {
  const file = loadConfig()
  const rows = await rowsFor(file)
  if (ctx.json) {
    emitResult(
      ctx,
      { path: file.path, settings: file.settings, ssh: file.ssh, targets: rows },
      { truncated: false },
    )
    return 0
  }

  write(`config  ${file.path}\n`)
  write(
    plainSettings({
      timeout_ms: file.settings.timeout_ms,
      max_rows: file.settings.max_rows,
      data_dir: file.settings.data_dir,
      git_author: file.settings.git_author ?? '-',
    }),
  )
  write(`\nssh hosts  ${file.ssh.hosts.join(', ') || '(none)'}\n`)
  const defaults = Object.entries(file.settings.default_targets)
  write(`defaults   ${defaults.map(([kind, name]) => `${kind}=${name}`).join(' ') || '(none)'}\n`)
  write('\n')
  emitResult(ctx, rows, {
    columns: ['name', 'kind', 'endpoint', 'auth', 'secret', 'credential'],
    truncated: false,
  })
  return 0
}, }

function plainSettings(values: Record<string, unknown>): string {
  const width = Math.max(...Object.keys(values).map((key) => key.length))
  return Object.entries(values)
    .map(([key, value]) => `${key.padEnd(width)}  ${String(value)}\n`)
    .join('')
}

const initVerb: CommandNode = { summary: 'Write the commented example configuration',
usage: [
  'crafty config init [options]',
  '',
  'Writes the example from the README to the resolved path, 0600 because the',
  'file holds the credentials. An existing file is left alone unless --force',
  'is passed.',
  '',
  'Options:',
  '  --force     Overwrite an existing file',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
options: [{ name: 'force', type: 'boolean' }],
run: async (ctx) => {
  const path = resolvedConfigPath()
  if (existsSync(path) && !flag(ctx.values, 'force')) {
    throw new OpsError(`${path} already exists`, 'conflict', { hint: 'pass --force to overwrite it' })
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, configTemplate(), { mode: 0o600 })
  } catch (error) {
    throw new OpsError(`cannot write ${path}: ${errorMessage(error)}`, 'config', { cause: error })
  }

  emitResult(ctx, { path, written: true }, { truncated: false })
  if (!ctx.json) writeErr(`next: fill in the REPLACE fields, then run \`crafty doctor\`\n`)
  return 0
}, }

export default {
  name: 'config',
  summary: 'Where settings come from, and how to write a starting file',
  source: 'config',
  commands: {
    path: pathVerb,
    show: showVerb,
    init: initVerb,
  },
} satisfies CommandModule
