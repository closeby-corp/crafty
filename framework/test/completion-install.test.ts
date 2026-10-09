import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import completion from '../src/plugins/completion.ts'
import { installCompletion } from '../src/plugins/completion-install.ts'
import { envelope, runCaptured } from './helpers/cli.ts'

const roots: string[] = []
const bashVersion = spawnSync('bash', ['--version'], { encoding: 'utf8' })
// This test exercises POSIX paths and PATH semantics; Git Bash on Windows is not
// a supported environment for this integration check.
const hasSupportedBash = process.platform !== 'win32' && !bashVersion.error && bashVersion.status === 0 &&
  Number(bashVersion.stdout.match(/version\s+(\d+)/i)?.[1] ?? 0) >= 4
const hasPosixFileModes = process.platform !== 'win32'

function unavailableWindowsSymlink(error: unknown): boolean {
  const code = (error as { code?: string }).code
  return process.platform === 'win32' && ['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(code ?? '')
}

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crafty-completion-install-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('completion installation', () => {
  test('preserves startup bytes and POSIX permissions when available, adds a newline, and is idempotent', async () => {
    const root = await home()
    const path = join(root, '.bashrc')
    const original = Buffer.from('# personal settings\r\nexport CUSTOM=kept')
    await writeFile(path, original)
    if (hasPosixFileModes) await chmod(path, 0o640)
    const options = { program: 'ops', shell: 'bash', home: root }
    const first = await installCompletion(options)
    expect(first).toEqual({
      shell: 'bash', path, changed: true,
      activation: `Bash reads '${path}' for interactive non-login shells. For interactive login shells, add this line to your login profile if it does not already source '${path}':\nsource '${path}'`,
    })
    const installed = await readFile(path)
    expect(installed.subarray(0, original.length)).toEqual(original)
    expect(installed[original.length]).toBe(10)
    if (hasPosixFileModes) expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect(await installCompletion(options)).toEqual({ ...first, changed: false })
    expect(await readFile(path)).toEqual(installed)
  })

  test('different executable registrations coexist without invalidating either installation', async () => {
    const root = await home()
    await installCompletion({ program: 'ops', shell: 'bash', home: root })
    await installCompletion({ program: 'deploy', shell: 'bash', home: root })
    const path = join(root, '.bashrc')
    const installed = await readFile(path)
    for (const program of ['ops', 'deploy']) {
      expect((await installCompletion({ program, shell: 'bash', home: root })).changed).toBe(false)
    }
    expect(await readFile(path)).toEqual(installed)
    if (hasPosixFileModes) expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('honors ZDOTDIR and follows startup symlinks when the host permits them', async () => {
    const root = await home()
    const zdotdir = join(root, 'zsh config')
    await mkdir(zdotdir)
    const target = join(root, 'versioned-zshrc')
    const path = join(zdotdir, '.zshrc')
    await writeFile(target, 'export CUSTOM=kept\n')
    let hasSymlink = true
    try {
      await symlink(target, path, 'file')
    } catch (error) {
      if (!unavailableWindowsSymlink(error)) throw error
      hasSymlink = false
      await writeFile(path, 'export CUSTOM=kept\n')
    }
    expect(await installCompletion({ program: 'ops', shell: 'zsh', home: root, zdotdir }))
      .toEqual({ shell: 'zsh', path, changed: true, activation: `Open a new interactive Zsh shell to activate completions from '${path}'.` })
    if (hasSymlink) expect((await lstat(path)).isSymbolicLink()).toBe(true)
    expect((await readFile(target, 'utf8')).startsWith('export CUSTOM=kept\n')).toBe(true)
    expect(await readFile(path)).toEqual(await readFile(target))
    expect(await Bun.file(join(root, '.zshrc')).exists()).toBe(false)
  })

  test('unsupported shells cannot mutate an existing startup file', async () => {
    const root = await home()
    const path = join(root, '.bashrc')
    await writeFile(path, 'personal\n')
    await expect(installCompletion({ program: 'ops', shell: 'fish', home: root }))
      .rejects.toThrow('supports Bash and Zsh')
    expect(await readFile(path, 'utf8')).toBe('personal\n')
  })

  test('refuses to overwrite an edited or incomplete managed block', async () => {
    const root = await home()
    const options = { program: 'ops', shell: 'bash', home: root }
    const { path } = await installCompletion(options)
    const installed = await readFile(path, 'utf8')
    const edited = installed.replace('source <(', '# user disabled: source <(')
    await writeFile(path, edited)
    await expect(installCompletion(options)).rejects.toThrow('edited or incomplete')
    expect(await readFile(path, 'utf8')).toBe(edited)
    const incomplete = installed.slice(0, installed.indexOf('\n') + 1)
    await writeFile(path, incomplete)
    await expect(installCompletion(options)).rejects.toThrow('edited or incomplete')
    expect(await readFile(path, 'utf8')).toBe(incomplete)
  })

  test('rejects non-file startup paths without hanging or creating nested files', async () => {
    const root = await home()
    const path = join(root, '.bashrc')
    await mkdir(path)
    await expect(installCompletion({ program: 'ops', shell: 'bash', home: root }))
      .rejects.toThrow('not a regular file')
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test.skipIf(!hasSupportedBash)('quotes a Bash login-profile source command for unusual paths and reports it when already installed', async () => {
    const root = await home()
    const specialHome = join(root, "user's shell config $HOME")
    const path = join(specialHome, '.bashrc')
    const bin = join(root, 'bin')
    const executable = join(bin, "ops's")
    await mkdir(bin)
    await writeFile(executable, "#!/bin/sh\nif [ \"$1\" = completion ] && [ \"$2\" = bash ]; then\n  printf '%s\\n' 'CRAFTY_TEST_ACTIVATED=loaded' '_fixture_completion() { :; }'\nfi\n")
    await chmod(executable, 0o700)
    const result = await installCompletion({ program: "ops's", shell: 'bash', home: specialHome })
    const sourceLine = `source '${path.replaceAll("'", "'\\''")}'`
    expect(result.activation).toContain(`For interactive login shells, add this line to your login profile if it does not already source '${path.replaceAll("'", "'\\''")}'`)
    expect(result.activation.split('\n')[1]).toBe(sourceLine)
    const activated = spawnSync('bash', [
      '--noprofile', '--norc', '-c',
      `${sourceLine}\nprintf '%s|%s' "$CRAFTY_TEST_ACTIVATED" "$(type -t _fixture_completion)"`,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } })
    expect(activated.error).toBeUndefined()
    expect(activated.status).toBe(0)
    expect(activated.stdout).toBe('loaded|function')
    const repeated = await installCompletion({ program: "ops's", shell: 'bash', home: specialHome })
    expect(repeated.changed).toBe(false)
    expect(repeated.activation).toBe(result.activation)
    expect(await readFile(path, 'utf8')).toContain("command 'ops'\\''s' completion bash")
  })

  test('shows the Bash activation notice in human and JSON CLI output', async () => {
    const root = await home()
    const previousHome = process.env.HOME
    process.env.HOME = root
    try {
      const command = { ...completion, name: 'completion' }
      const human = await runCaptured(command, ['install', '--shell', 'bash'], 'ops')
      expect(human.code).toBe(0)
      expect(human.stdout).toContain('Bash reads ')
      expect(human.stdout).toContain('For interactive login shells, add this line to your login profile')
      expect(human.stdout).toContain(`source '${join(root, '.bashrc')}'`)
      expect(await readFile(join(root, '.bashrc'), 'utf8')).toContain('command \'ops\' completion bash')

      const json = await runCaptured(command, ['--json', 'install', '--shell', 'bash'], 'ops')
      expect(json.code).toBe(0)
      const data = envelope(json).data as { activation: string; changed: boolean }
      expect(data.activation).toContain('For interactive login shells, add this line to your login profile')
      expect(data.activation).toContain(`source '${join(root, '.bashrc')}'`)
      expect(data.changed).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })
})
