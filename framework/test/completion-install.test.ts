import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCompletion } from '../src/plugins/completion-install.ts'

const roots: string[] = []
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crafty-completion-install-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('completion installation', () => {
  test('preserves startup bytes and permissions, adds a newline, and repeated installation is unchanged', async () => {
    const root = await home()
    const path = join(root, '.bashrc')
    const original = Buffer.from('# personal settings\r\nexport CUSTOM=kept')
    await writeFile(path, original)
    await chmod(path, 0o640)
    const options = { program: 'ops', shell: 'bash', home: root }
    expect(await installCompletion(options)).toEqual({ shell: 'bash', path, changed: true })
    const installed = await readFile(path)
    expect(installed.subarray(0, original.length)).toEqual(original)
    expect(installed[original.length]).toBe(10)
    expect((await stat(path)).mode & 0o777).toBe(0o640)
    expect(await installCompletion(options)).toEqual({ shell: 'bash', path, changed: false })
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
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('honors ZDOTDIR and follows existing startup symlinks without replacing them', async () => {
    const root = await home()
    const zdotdir = join(root, 'zsh config')
    await mkdir(zdotdir)
    const target = join(root, 'versioned-zshrc')
    const path = join(zdotdir, '.zshrc')
    await writeFile(target, 'export CUSTOM=kept\n')
    await symlink(target, path)
    expect(await installCompletion({ program: 'ops', shell: 'zsh', home: root, zdotdir }))
      .toEqual({ shell: 'zsh', path, changed: true })
    expect((await lstat(path)).isSymbolicLink()).toBe(true)
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
})
