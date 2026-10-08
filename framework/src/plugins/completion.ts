import { homedir } from 'node:os'
import { basename } from 'node:path'
import { commands, option, write } from '../cli.ts'
import type { CommandModule } from '../command.ts'
import { completeWords } from '../completion.ts'
import { usageError } from '../errors.ts'
import { emitResult, type Ctx } from '../output.ts'
import { bashCompletion, quote, zshCompletion } from './completion-shells.ts'
import { installCompletion } from './completion-install.ts'

function programIdentity(ctx: Ctx, action: 'bash' | 'zsh' | 'install'): string {
  const suffix = ` completion ${action}`
  if (!ctx.path.endsWith(suffix)) throw usageError('completion must be registered as "completion"')
  const program = ctx.path.slice(0, -suffix.length)
  if (!program || program.includes('\0')) throw usageError('completion requires an executable name')
  return program
}

const completion: CommandModule = {
  name: 'completion',
  summary: 'Generate, install, or query optional dynamic shell completion',
  commands: {
    install: {
      summary: 'Install dynamic completion in Bash/Zsh startup files; defaults to $SHELL',
      options: [{ name: 'shell', type: 'string', completion: ['bash', 'zsh'] }],
      async run(ctx) {
        const result = await installCompletion({
          program: programIdentity(ctx, 'install'),
          shell: option(ctx.values, 'shell') ?? basename(process.env.SHELL ?? ''),
          home: homedir(),
          zdotdir: process.env.ZDOTDIR,
        })
        if (ctx.json || ctx.format !== 'auto') {
          emitResult(ctx, result)
        } else {
          write(`${result.changed ? 'Installed' : 'Already installed'} ${result.shell} completion in ${quote(result.path)}.\nOpen a new shell to activate completions.\n`)
        }
      },
    },
    bash: {
      summary: 'Print a Bash registration script for this executable',
      run(ctx) {
        write(bashCompletion(programIdentity(ctx, 'bash')))
      },
    },
    zsh: {
      summary: 'Print a Zsh registration script; run compinit before sourcing it',
      run(ctx) {
        write(zshCompletion(programIdentity(ctx, 'zsh')))
      },
    },
    query: {
      summary: 'Return NUL-delimited completion records for words after --',
      options: [{ name: 'index', type: 'string' }],
      async run(ctx) {
        const raw = option(ctx.values, 'index')
        if (raw === undefined || !/^\d+$/.test(raw)) {
          throw usageError('--index must be a nonnegative integer')
        }
        const index = Number(raw)
        if (!Number.isSafeInteger(index) || ctx.tail.length === 0 || index > ctx.tail.length) {
          throw usageError('--index must identify a word after --, or the empty word immediately after them')
        }
        const result = await completeWords(commands(), ctx.tail, index)
        write([result.kind, result.prefix, result.replacementPrefix, ...result.candidates].join('\0') + '\0')
      },
    },
  },
}

export default completion
