import { commands, option, write } from '../cli.ts'
import type { CommandModule } from '../command.ts'
import { completeWords } from '../completion.ts'
import { usageError } from '../errors.ts'
import type { Ctx } from '../output.ts'
import { bashCompletion, zshCompletion } from './completion-shells.ts'

function programIdentity(ctx: Ctx, shell: 'bash' | 'zsh'): string {
  const suffix = ` completion ${shell}`
  if (!ctx.path.endsWith(suffix)) throw usageError('completion must be registered as "completion"')
  const program = ctx.path.slice(0, -suffix.length)
  if (!program || program.includes('\0')) throw usageError('completion requires an executable name')
  return program
}

const completion: CommandModule = {
  name: 'completion',
  summary: 'Generate optional shell completion or query current command metadata',
  commands: {
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
      run(ctx) {
        const raw = option(ctx.values, 'index')
        if (raw === undefined || !/^\d+$/.test(raw)) {
          throw usageError('--index must be a nonnegative integer')
        }
        const index = Number(raw)
        if (!Number.isSafeInteger(index) || ctx.tail.length === 0 || index > ctx.tail.length) {
          throw usageError('--index must identify a word after --, or the empty word immediately after them')
        }
        const result = completeWords(commands(), ctx.tail, index)
        write([result.kind, result.prefix, result.replacementPrefix, ...result.candidates].join('\0') + '\0')
      },
    },
  },
}

export default completion
