import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureCli, envelope, runCaptured } from './helpers/cli.ts'
import {
  commands, prepareCommand, setCommands, start, type CommandStartupContext, type RegisteredCommand,
} from '../src/index.ts'
import { createUpdatePlugin } from '../src/plugins/update.ts'

const roots: string[] = []
let registry: RegisteredCommand[] = []

function git(root: string, args: string[]): string {
  const result = childProcess.spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

async function makeCheckout(github = false): Promise<{ root: string; remote: string; local: string }> {
  const root = await mkdtemp(join(tmpdir(), 'crafty-update-plugin-'))
  roots.push(root)
  const remote = join(root, 'remote')
  const local = join(root, 'local')
  await Promise.all([mkdir(remote), mkdir(local)])

  const initRemote = childProcess.spawnSync('git', ['init', '--quiet', remote], { encoding: 'utf8', windowsHide: true })
  if (initRemote.status !== 0) throw new Error(`git init remote failed: ${initRemote.stderr}`)
  const initLocal = childProcess.spawnSync('git', ['init', '--quiet', local], { encoding: 'utf8', windowsHide: true })
  if (initLocal.status !== 0) throw new Error(`git init local failed: ${initLocal.stderr}`)
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(local, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(remote, ['config', 'user.name', 'Crafty Test'])
  git(remote, ['config', 'user.email', 'crafty-test@example.invalid'])
  await writeFile(join(remote, 'README.md'), 'initial\n')
  git(remote, ['add', 'README.md'])
  git(remote, ['commit', '--quiet', '-m', 'initial'])
  git(local, ['remote', 'add', 'origin', remote])
  git(local, ['fetch', '--quiet', 'origin'])
  git(local, ['checkout', '--quiet', '--track', '-b', 'main', 'origin/main'])
  if (github) git(local, ['remote', 'set-url', 'origin', 'https://github.com/example/cli.git'])
  return { root, remote, local }
}

function addRemoteCommit(remote: string, name: string, contents: string): void {
  git(remote, ['config', 'user.name', 'Crafty Test'])
  git(remote, ['config', 'user.email', 'crafty-test@example.invalid'])
  writeFileSync(join(remote, name), contents)
  git(remote, ['add', name])
  git(remote, ['commit', '--quiet', '-m', `add ${name}`])
}

function mockGh(response: string) {
  const realSpawn = childProcess.spawn
  const ghCalls: Array<{ args: string[]; options: unknown }> = []
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(((executable: unknown, args: unknown, options: unknown) => {
    if (executable !== 'gh') return realSpawn(executable as never, args as never, options as never)
    ghCalls.push({ args: args as string[], options })
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: () => boolean
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    queueMicrotask(() => {
      child.stdout.end(response)
      child.stderr.end()
      child.emit('close', 0)
    })
    return child as never
  }) as never)
  return { ghCalls, spawn }
}

beforeEach(() => {
  registry = commands()
})

afterEach(async () => {
  setCommands(registry)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('update plugin', () => {
  test('checks the configured upstream and fast-forwards only a clean checkout', async () => {
    const { root, remote, local } = await makeCheckout()
    addRemoteCommit(remote, 'next.txt', 'new version\n')
    const plugin = createUpdatePlugin({ repositoryDir: local, cacheDirectory: join(root, 'cache'), autoCheck: false })

    const checked = await runCaptured(plugin, ['--check', '--json'])
    expect(checked.code).toBe(0)
    expect(envelope(checked).data).toMatchObject({
      branch: 'main', remote: 'origin', remoteBranch: 'main', remoteAhead: 1, localAhead: 0, checkedVia: 'git', updateAvailable: true,
    })

    const updated = await runCaptured(plugin, [])
    expect(updated.code).toBe(0)
    expect(updated.stderr).toContain('Restart crafty to load the new version')
    expect(await readFile(join(local, 'next.txt'), 'utf8')).toBe('new version\n')

    git(local, ['config', 'user.name', 'Crafty Test'])
    git(local, ['config', 'user.email', 'crafty-test@example.invalid'])
    writeFileSync(join(local, 'local.txt'), 'local commit\n')
    git(local, ['add', 'local.txt'])
    git(local, ['commit', '--quiet', '-m', 'local commit'])
    addRemoteCommit(remote, 'remote.txt', 'remote commit\n')
    const diverged = await runCaptured(plugin, [])
    expect(diverged.code).toBe(1)
    expect(diverged.stderr).toContain('could not fast-forward')
    expect(await readFile(join(local, 'local.txt'), 'utf8')).toBe('local commit\n')

    await writeFile(join(local, 'untracked.txt'), 'keep me\n')
    const refused = await runCaptured(plugin, [])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('local or untracked changes')
    expect(await readFile(join(local, 'untracked.txt'), 'utf8')).toBe('keep me\n')
    expect(plugin.mcp).toBe('write')
    expect(prepareCommand('update', plugin).definition.mcp).toBe('write')
  })

  test('uses gh for GitHub comparisons and rate-limits interactive startup notices', async () => {
    const { root, local } = await makeCheckout(true)
    const { ghCalls, spawn } = mockGh('{"ahead_by":2,"behind_by":1}\n')
    const stderr: string[] = []
    const stderrWrite = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })
    try {
      const plugin = createUpdatePlugin({ repositoryDir: local, cacheDirectory: join(root, 'cache') })
      const context: CommandStartupContext = {
        argv: ['echo', 'hello'], program: 'demo', commandsDir: join(root, 'commands'), interactive: true,
      }
      await plugin.onStart?.(context)
      await plugin.onStart?.(context)

      expect(ghCalls).toHaveLength(1)
      expect(ghCalls[0]?.args).toContain('--hostname')
      expect(ghCalls[0]?.args.some((arg) => arg.includes('/compare/') && arg.includes('...main'))).toBe(true)
      expect(ghCalls[0]?.options).toMatchObject({ cwd: local, shell: false, windowsHide: true })
      expect(stderr.join('')).toContain('2 commits available from origin/main')
      expect(stderr.join('')).toContain('also has 1 unpushed commit')
    } finally {
      stderrWrite.mockRestore()
      spawn.mockRestore()
    }
  })

  test('does not run startup checks for non-interactive, help, completion, or update invocations', async () => {
    const { root, local } = await makeCheckout(true)
    const { ghCalls, spawn } = mockGh('{"ahead_by":1,"behind_by":0}\n')
    try {
      const plugin = createUpdatePlugin({ repositoryDir: local, cacheDirectory: join(root, 'cache') })
      const invoke = (argv: string[], interactive: boolean) => plugin.onStart?.({
        argv, program: 'demo', commandsDir: root, interactive,
      })
      await invoke(['echo'], false)
      await invoke(['--help'], true)
      await invoke(['completion', 'query'], true)
      await invoke(['update'], true)
      const disabled = createUpdatePlugin({ repositoryDir: local, cacheDirectory: join(root, 'disabled-cache'), autoCheck: false })
      await disabled.onStart?.({ argv: ['echo'], program: 'demo', commandsDir: root, interactive: true })
      expect(ghCalls).toHaveLength(0)
    } finally {
      spawn.mockRestore()
    }
  })

  test('the framework invokes module startup hooks after discovery and before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crafty-start-hook-'))
    roots.push(root)
    const commandsDir = join(root, 'commands')
    await mkdir(commandsDir)
    const marker = join(root, 'startup.json')
    await writeFile(join(commandsDir, 'hello.ts'), `
      import type { CommandModule } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}
      import { writeFileSync } from 'node:fs'
      const command: CommandModule = {
        name: 'hello',
        onStart(ctx) { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: ctx.argv, program: ctx.program, interactive: ctx.interactive })) },
        run() {},
      }
      export default command
    `)

    const result = await captureCli(() => start({ commandsDir, argv: ['hello'], program: 'hook-cli' }))
    expect(result.code).toBe(0)
    expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ argv: ['hello'], program: 'hook-cli', interactive: Boolean(process.stderr.isTTY) })
  })
})
