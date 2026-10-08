import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { usageError } from '../errors.ts'
import { quote } from './completion-shells.ts'

interface InstallOptions {
  program: string
  shell: string
  home: string
  zdotdir?: string
}

export interface CompletionInstallation {
  shell: 'bash' | 'zsh'
  path: string
  changed: boolean
}

/** Append only our registration block; leave existing bytes, modes and symlinks intact. */
export async function installCompletion({ program, shell, home, zdotdir }: InstallOptions): Promise<CompletionInstallation> {
  if (shell !== 'bash' && shell !== 'zsh') {
    throw usageError('Completion installation supports Bash and Zsh. Pass --shell bash or --shell zsh.')
  }
  if (!program || program.includes('\0')) throw usageError('completion requires an executable name')
  const path = resolve(shell === 'zsh' ? `${zdotdir ?? home}/.zshrc` : `${home}/.bashrc`)
  const id = createHash('sha256').update(`${shell}\0${program}`).digest('hex')
  const begin = `# >>> crafty completion ${id} >>>`
  const end = `# <<< crafty completion ${id} <<<`
  const initialization = shell === 'zsh'
    ? '  if (( ! $+functions[compdef] )); then\n    autoload -Uz compinit\n    compinit\n  fi\n'
    : ''
  const block = `${begin}\nif command -v ${quote(program)} >/dev/null 2>&1; then\n${initialization}  source <(command ${quote(program)} completion ${shell})\nfi\n${end}\n`
  let existing = ''
  try {
    if (!(await stat(path)).isFile()) throw usageError(`Shell startup path is not a regular file: ${path}`)
    existing = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (existing.includes(block)) return { shell, path, changed: false }
  if (existing.includes(begin) || existing.includes(end)) {
    throw usageError(`An edited or incomplete Crafty completion block already exists in ${path}. Remove that block before reinstalling.`)
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, `${existing && !existing.endsWith('\n') ? '\n' : ''}${block}`, { mode: 0o600 })
  return { shell, path, changed: true }
}
