import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setCommands } from './cli.ts'
import { prepareCommand } from './command.ts'
import type { CommandModule, RegisteredCommand } from './command.ts'
import { errorMessage, OpsError } from './errors.ts'
import { redactString } from './log.ts'

/** Discover direct TypeScript command files in the client-supplied directory. */
export async function loadCommands(directory: string | URL): Promise<void> {
  const absolute = resolve(directory instanceof URL ? fileURLToPath(directory) : directory)
  let files: string[]
  try {
    const entries = await readdir(absolute, { withFileTypes: true })
    files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
      .map((entry) => entry.name).sort()
  } catch (error) {
    throw new OpsError(`cannot read command directory ${absolute}: ${redactString(errorMessage(error))}`, 'config', { source: 'commands', cause: error })
  }

  const loaded: RegisteredCommand[] = []
  const owners = new Map<string, string>()
  for (const filename of files) {
    const file = join(absolute, filename)
    try {
      const moduleUrl = pathToFileURL(file).href
      // Exception: runtime-discovered command files cannot be statically imported.
      const imported = await import(moduleUrl)
      const definition: unknown = imported.default
      if (definition === null || typeof definition !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(definition))) {
        throw new Error('default export must be a plain command object')
      }
      const module = definition as CommandModule
      const command = prepareCommand(module.name ?? basename(filename, '.ts'), module)
      for (const token of [command.name, ...(command.definition.aliases ?? [])]) {
        const owner = owners.get(token)
        if (owner) throw new Error(`command name or alias "${token}" collides with ${owner}`)
        owners.set(token, file)
      }
      loaded.push(command)
    } catch (error) {
      throw new OpsError(`cannot load command file ${file}: ${redactString(errorMessage(error))}`, 'config', { source: 'commands', cause: error })
    }
  }
  setCommands(loaded)
}
