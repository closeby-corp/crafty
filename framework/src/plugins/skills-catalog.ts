import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpsError, errorMessage } from '../errors.ts'

/** Metadata for one client-owned, static skill document. */
export interface SkillInfo {
  name: string
  description: string
  path: string
}

const SAFE_SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function configuredPath(directory: string | URL): string {
  return resolve(directory instanceof URL ? fileURLToPath(directory) : directory)
}

function configError(message: string, path: string, cause?: unknown): OpsError {
  return new OpsError(message, 'config', { source: 'skills', target: path, cause })
}

function validateName(name: string): void {
  if (!SAFE_SKILL_NAME.test(name) || name.length > 64) {
    throw new OpsError(`invalid skill name "${name}"`, 'usage', { source: 'skills' })
  }
}

async function statNode(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path)
  } catch (error) {
    throw configError(`cannot inspect ${label} ${path}: ${errorMessage(error)}`, path, error)
  }
}

/** Validate every node that an installer could otherwise copy out of the skill tree. */
async function validateResourceTree(directory: string): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    throw configError(`cannot read skill resources in ${directory}: ${errorMessage(error)}`, directory, error)
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    const info = await statNode(path, 'skill resource')
    if (info.isSymbolicLink()) {
      throw configError(`skill resources cannot contain symbolic links: ${path}`, path)
    }
    if (info.isDirectory()) {
      await validateResourceTree(path)
    } else if (!info.isFile()) {
      throw configError(`skill resources must be regular files or directories: ${path}`, path)
    }
  }
}

async function readDocument(path: string): Promise<string> {
  let handle
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0
    handle = await open(path, fsConstants.O_RDONLY | noFollow)
    const info = await handle.stat()
    if (!info.isFile()) throw configError(`skill document must be a regular file: ${path}`, path)
    return await handle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if (error instanceof OpsError) throw error
    throw configError(`cannot read skill document ${path}: ${errorMessage(error)}`, path, error)
  } finally {
    await handle?.close()
  }
}

function parseDocument(content: string, directoryName: string, path: string): Pick<SkillInfo, 'name' | 'description'> & { internal: boolean } {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) throw configError(`skill document ${path} must start with YAML frontmatter`, path)

  let metadata: unknown
  try {
    metadata = Bun.YAML.parse(match[1]!)
  } catch (error) {
    throw configError(`invalid YAML frontmatter in ${path}: ${errorMessage(error)}`, path, error)
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw configError(`skill metadata in ${path} must be a YAML mapping`, path)
  }

  const fields = metadata as Record<string, unknown>
  const name = fields.name
  const description = fields.description
  if (typeof name !== 'string' || typeof description !== 'string' || !description.trim()) {
    throw configError(`skill metadata in ${path} requires string name and non-empty description fields`, path)
  }
  if (!SAFE_SKILL_NAME.test(name) || name.length > 64) {
    throw configError(`skill metadata in ${path} has an invalid name "${name}"`, path)
  }
  if (name !== directoryName) {
    throw configError(`skill name "${name}" must match its directory "${directoryName}"`, path)
  }
  if (fields.internal !== undefined && typeof fields.internal !== 'boolean') {
    throw configError(`skill metadata in ${path} has a non-boolean internal field`, path)
  }
  return { name, description, internal: fields.internal === true }
}

async function discover(skillsDir: string | URL): Promise<Array<SkillInfo & { content: string }>> {
  const configured = configuredPath(skillsDir)
  let root: string
  try {
    // A configured root may itself be a symlink; all discovered skill paths are
    // anchored at its resolved target, while links inside the catalog are rejected.
    root = await realpath(configured)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory()) throw configError(`skills source is not a directory: ${configured}`, configured)
  } catch (error) {
    if (error instanceof OpsError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new OpsError(`skills source directory does not exist: ${configured}`, 'config', {
        source: 'skills', target: configured,
        hint: 'Configure the client skills directory or create it before listing skills.', cause: error,
      })
    }
    throw configError(`cannot read skills source directory ${configured}: ${errorMessage(error)}`, configured, error)
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    throw configError(`cannot read skills source directory ${configured}: ${errorMessage(error)}`, configured, error)
  }

  const found: Array<SkillInfo & { content: string }> = []
  const names = new Set<string>()
  for (const entry of entries) {
    const directory = join(root, entry.name)
    const info = await statNode(directory, 'skill entry')
    if (info.isSymbolicLink()) throw configError(`skill directories cannot be symbolic links: ${directory}`, directory)
    if (entry.name === 'SKILL.md') {
      throw configError(`root SKILL.md is not supported; use skills/<name>/SKILL.md under ${configured}`, directory)
    }
    if (!info.isDirectory()) continue

    const name = entry.name
    if (!SAFE_SKILL_NAME.test(name) || name.length > 64) {
      throw configError(`invalid skill directory name "${name}" in ${configured}`, directory)
    }
    if (names.has(name)) throw configError(`duplicate skill name "${name}" in ${configured}`, directory)
    names.add(name)

    const document = join(directory, 'SKILL.md')
    const documentInfo = await statNode(document, 'skill document')
    if (documentInfo.isSymbolicLink()) throw configError(`skill document cannot be a symbolic link: ${document}`, document)
    if (!documentInfo.isFile()) throw configError(`skill document must be a regular file: ${document}`, document)
    await validateResourceTree(directory)
    const content = await readDocument(document)
    const metadata = parseDocument(content, name, document)
    // Continue validating hidden skills and their resources above, but never
    // make them available through this catalog or to installer selection.
    if (!metadata.internal) found.push({ name: metadata.name, description: metadata.description, path: document, content })
  }

  return found.sort((left, right) => left.name.localeCompare(right.name))
}

/** Discover and validate static client skills in skills/<name>/SKILL.md form. */
export async function listSkills(skillsDir: string | URL): Promise<SkillInfo[]> {
  const entries = await discover(skillsDir)
  return entries.map(({ name, description, path }) => ({ name, description, path }))
}

/** Read one skill's static Markdown after validating the complete local catalog. */
export async function readSkill(skillsDir: string | URL, name: string): Promise<SkillInfo & { content: string }> {
  validateName(name)
  // Lookup is against discovered names; caller input is never joined to a path.
  const skill = (await discover(skillsDir)).find((candidate) => candidate.name === name)
  if (!skill) {
    throw new OpsError(`skill "${name}" was not found`, 'not-found', { source: 'skills' })
  }
  return skill
}
