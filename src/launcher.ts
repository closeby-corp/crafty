import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const layout = 'dist/crafty beside src/, recipes/, package.json, and config.example.yml'
try {
  const root = resolve(dirname(realpathSync(process.execPath)), '..')
  for (const path of ['src/main.ts', 'src/commands', 'recipes', 'package.json', 'config.example.yml']) {
    if (!existsSync(join(root, path))) throw new Error(`missing runtime path ${join(root, path)}`)
  }
  const moduleUrl = pathToFileURL(join(root, 'src/main.ts')).href
  // Exception: the installed source entrypoint is selected from the real executable path at runtime.
  await import(moduleUrl)
} catch (error) {
  process.stderr.write(`crafty launcher: ${error instanceof Error ? error.message : String(error)}\nRequired project layout: ${layout}\n`)
  process.exitCode = 1
}
