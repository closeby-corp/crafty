import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tempRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crafty-package-consumer-')))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function runBun(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  })
}

describe('installed package consumer', () => {
  test('packs, installs, and exercises the published package from a separate client', async () => {
    const root = await temporaryRoot()
    const tarballDir = join(root, 'artifacts')
    const consumerDir = join(root, 'client')
    const unrelatedCwd = join(root, 'elsewhere')
    await Promise.all([tarballDir, consumerDir, unrelatedCwd].map((path) => mkdir(path, { recursive: true })))

    const packed = runBun(['pm', 'pack', '--destination', tarballDir, '--quiet'], frameworkRoot)
    expect(packed.error).toBeUndefined()
    if (packed.status !== 0) throw new Error(`package pack failed (${packed.status}): ${packed.stdout}${packed.stderr}`)
    const tarballName = (await readdir(tarballDir)).find((name) => name.endsWith('.tgz'))
    expect(tarballName).toBeDefined()

    await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
      name: 'crafty-installed-consumer',
      private: true,
      type: 'module',
      dependencies: { crafty: `file:../artifacts/${tarballName}` },
    }))

    const installed = runBun(['install', '--no-save'], consumerDir)
    expect(installed.error).toBeUndefined()
    if (installed.status !== 0) throw new Error(`package install failed (${installed.status}): ${installed.stdout}${installed.stderr}`)

    const inspectPath = join(consumerDir, 'inspect.mjs')
    await writeFile(inspectPath, `
      import * as framework from 'crafty'
      import completion from 'crafty/plugins/completion'
      import { createSkillsPlugin } from 'crafty/plugins/skills'
      import { createUpdatePlugin } from 'crafty/plugins/update'
      import { dirname, resolve } from 'node:path'
      import { fileURLToPath } from 'node:url'
      const entry = fileURLToPath(import.meta.resolve('crafty'))
      console.log(JSON.stringify({
        entry,
        packageRoot: resolve(dirname(entry), '..'),
        skill: fileURLToPath(import.meta.resolve('crafty/SKILL.md')),
        exports: ['start', 'loadCommands', 'log', 'registerSecret', 'OpsError'].every((key) => key in framework),
        completion: typeof completion === 'object',
        skillsPlugin: typeof createSkillsPlugin === 'function',
        updatePlugin: typeof createUpdatePlugin === 'function',
      }))
    `)
    const inspected = runBun([inspectPath], unrelatedCwd)
    expect(inspected.error).toBeUndefined()
    expect(inspected.status).toBe(0)
    const details = JSON.parse(inspected.stdout.trim()) as {
      entry: string
      packageRoot: string
      skill: string
      exports: boolean
      completion: boolean
      skillsPlugin: boolean
      updatePlugin: boolean
    }
    expect(details.exports).toBe(true)
    expect(details.completion).toBe(true)
    expect(details.skillsPlugin).toBe(true)
    expect(details.updatePlugin).toBe(true)
    const relativePackagePath = relative(join(consumerDir, 'node_modules'), details.packageRoot)
    expect(isAbsolute(relativePackagePath) || relativePackagePath === '..' || relativePackagePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)).toBe(false)
    expect(resolve(details.entry)).not.toBe(resolve(frameworkRoot, 'src/index.ts'))
    expect(await readFile(details.skill, 'utf8')).toContain('Crafty')
    const packageJson = JSON.parse(await readFile(join(details.packageRoot, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(packageJson.files).toContain('src')
    expect(packageJson.files).toContain('SKILL.md')
    const installedEntries = await readdir(details.packageRoot)
    expect(installedEntries).toContain('src')
    expect(installedEntries).toContain('SKILL.md')
    expect(installedEntries).not.toContain('test')
    expect(installedEntries).not.toContain('skills')

    const commandsDir = join(consumerDir, 'commands')
    await mkdir(commandsDir)
    const bundledSkillDir = join(consumerDir, 'skills', 'consumer-workflow')
    await mkdir(bundledSkillDir, { recursive: true })
    await writeFile(join(bundledSkillDir, 'SKILL.md'), '---\nname: consumer-workflow\ndescription: Use the installed consumer CLI.\n---\n\nRun consumer hello --json.\n')
    await writeFile(join(commandsDir, 'skills.ts'), `
      import { createSkillsPlugin } from 'crafty/plugins/skills'
      export default createSkillsPlugin({ skillsDir: new URL('../skills/', import.meta.url) })
    `)
    await writeFile(join(commandsDir, 'hello.ts'), `
      import { emitResult, log, type CommandModule } from 'crafty'
      const command: CommandModule = {
        name: 'hello',
        run(ctx) {
          log.info('consumer command ran', { api_key: 'embedded-field-secret' })
          emitResult(ctx, { installed: true, command: 'hello' })
        },
      }
      export default command
    `)
    await writeFile(join(commandsDir, 'fail.ts'), `
      import { OpsError, type CommandModule } from 'crafty'
      const command: CommandModule = {
        name: 'fail',
        run() { throw new OpsError('failed with z9', 'auth') },
      }
      export default command
    `)
    const entryPath = join(consumerDir, 'main.ts')
    await writeFile(entryPath, `
      import { start, registerSecret } from 'crafty'
      registerSecret('z9')
      const code = await start({
        commandsDir: new URL('./commands/', import.meta.url),
        argv: [...(process.argv.length > 2 ? process.argv.slice(2) : ['hello']), '--json'],
        program: 'consumer',
      })
      process.exitCode = code
    `)

    const success = runBun([entryPath, 'hello'], unrelatedCwd)
    expect(success.error).toBeUndefined()
    if (success.status !== 0) throw new Error(`consumer command failed (${success.status}): ${success.stdout}${success.stderr}`)
    expect(JSON.parse(success.stdout.trim())).toMatchObject({
      ok: true,
      data: { installed: true, command: 'hello' },
    })
    expect(success.stderr).toContain('"level":"info"')
    expect(success.stderr).toContain('[redacted]')
    expect(success.stderr).not.toContain('embedded-field-secret')

    const failure = runBun([entryPath, 'fail'], unrelatedCwd)
    expect(failure.error).toBeUndefined()
    expect(failure.status).toBe(3)
    expect(JSON.parse(failure.stdout.trim())).toMatchObject({
      ok: false,
      error: { kind: 'auth', message: 'failed with [redacted]' },
    })
    expect(failure.stdout).not.toContain('z9')

    const skills = runBun([entryPath, 'skills', 'list'], unrelatedCwd)
    expect(skills.error).toBeUndefined()
    expect(skills.status).toBe(0)
    expect(JSON.parse(skills.stdout).data).toMatchObject([
      { name: 'consumer-workflow', description: 'Use the installed consumer CLI.' },
    ])
    const skillContent = runBun([entryPath, 'skills', 'show', 'consumer-workflow'], unrelatedCwd)
    expect(skillContent.error).toBeUndefined()
    expect(skillContent.status).toBe(0)
    expect(JSON.parse(skillContent.stdout).data.content).toContain('Run consumer hello --json.')
  }, { timeout: 300_000 })
})
