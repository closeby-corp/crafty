import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listSkills, readSkill } from '../src/plugins/skills-catalog.ts'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crafty-skills-')))
  roots.push(root)
  return root
}

async function addSkill(root: string, name: string, frontmatter = `name: ${name}\ndescription: A ${name} skill`): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, `---\n${frontmatter}\n---\n\n# ${name}\n`)
  return path
}

function unavailableSymlink(error: unknown): boolean {
  return process.platform === 'win32' && ['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes((error as { code?: string }).code ?? '')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local skill catalog', () => {
  test('lists skills deterministically and reads static Markdown by discovered name', async () => {
    const root = await tempRoot()
    await addSkill(root, 'zebra', 'name: zebra\ndescription: |\n  A multiline\n  description')
    const alphaPath = await addSkill(root, 'alpha')

    expect(await listSkills(root)).toEqual([
      { name: 'alpha', description: 'A alpha skill', path: alphaPath },
      { name: 'zebra', description: 'A multiline\ndescription\n', path: join(root, 'zebra', 'SKILL.md') },
    ])
    const skill = await readSkill(pathToFileURL(`${root}/`), 'zebra')
    expect(skill.name).toBe('zebra')
    expect(skill.description).toBe('A multiline\ndescription\n')
    expect(skill.content).toContain('# zebra')
    expect(skill.path).toBe(join(root, 'zebra', 'SKILL.md'))
  })

  test('returns an empty catalog for an existing directory and actionable config failure when missing', async () => {
    const root = await tempRoot()
    await expect(listSkills(root)).resolves.toEqual([])
    await expect(listSkills(join(root, 'missing'))).rejects.toMatchObject({ kind: 'config', hint: expect.stringContaining('Configure') })
    await writeFile(join(root, 'SKILL.md'), '---\nname: root\ndescription: unsupported root skill\n---\n')
    await expect(listSkills(root)).rejects.toThrow('use skills/<name>/SKILL.md')
  })

  test('rejects unknown names and path traversal without resolving caller input as a path', async () => {
    const root = await tempRoot()
    await addSkill(root, 'known')
    await expect(readSkill(root, 'missing')).rejects.toMatchObject({ kind: 'not-found' })
    await expect(readSkill(root, '../known')).rejects.toMatchObject({ kind: 'usage' })
    await expect(readSkill(root, 'known/../../outside')).rejects.toMatchObject({ kind: 'usage' })
  })

  test('hides internal skills from discovery and direct reads', async () => {
    const root = await tempRoot()
    await addSkill(root, 'public')
    await addSkill(root, 'private', 'name: private\ndescription: Internal skill\ninternal: true')

    expect((await listSkills(root)).map(({ name }) => name)).toEqual(['public'])
    await expect(readSkill(root, 'private')).rejects.toMatchObject({ kind: 'not-found' })
  })

  test('rejects malformed frontmatter and directory metadata mismatches', async () => {
    const root = await tempRoot()
    await addSkill(root, 'broken', 'name: broken\ndescription: [unterminated')
    await expect(listSkills(root)).rejects.toMatchObject({ kind: 'config' })
    await rm(join(root, 'broken'), { recursive: true })
    await addSkill(root, 'folder', 'name: other\ndescription: Some description')
    await expect(listSkills(root)).rejects.toThrow('must match its directory')
    await rm(join(root, 'folder'), { recursive: true })
    await addSkill(root, 'missing-description', 'name: missing-description')
    await expect(listSkills(root)).rejects.toThrow('requires string name and non-empty description')
  })

  test('rejects symlinked skill directories, documents, and supplemental resources', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await addSkill(outside, 'linked')
    try {
      await symlink(join(outside, 'linked'), join(root, 'linked-skill'), 'dir')
    } catch (error) {
      if (!unavailableSymlink(error)) throw error
      return
    }
    await expect(listSkills(root)).rejects.toThrow('cannot be symbolic links')
    await rm(join(root, 'linked-skill'))

    await mkdir(join(root, 'linked-doc'))
    try {
      await symlink(join(outside, 'linked', 'SKILL.md'), join(root, 'linked-doc', 'SKILL.md'), 'file')
    } catch (error) {
      if (!unavailableSymlink(error)) throw error
      return
    }
    await expect(listSkills(root)).rejects.toThrow('cannot be a symbolic link')
    await rm(join(root, 'linked-doc'), { recursive: true })

    const resourcePath = await addSkill(root, 'resource-link')
    try {
      await symlink(join(outside, 'linked', 'SKILL.md'), join(root, 'resource-link', 'references.md'), 'file')
    } catch (error) {
      if (!unavailableSymlink(error)) throw error
      return
    }
    await expect(listSkills(root)).rejects.toThrow('cannot contain symbolic links')
    expect(resourcePath).toBe(join(root, 'resource-link', 'SKILL.md'))
  })
})
