import { emitResult, flag, write, type CommandModule } from 'crafty'

/**
 * Positional arguments, a boolean flag, a repeatable option and the raw `--`
 * tail. Everything after a standalone `--` stays in `ctx.tail`, untouched by
 * the parser, and is printed here verbatim.
 */
export default {
  name: 'echo',
  summary: 'Print the words it was given',
  options: [
    { name: 'upper', type: 'boolean' },
    { name: 'tag', type: 'string', repeatable: true },
  ],
  run(ctx) {
    const words = [...ctx.positionals, ...ctx.tail]
    const text = flag(ctx.values, 'upper') ? words.join(' ').toUpperCase() : words.join(' ')
    const tags = ctx.repeat['tag'] ?? []
    if (ctx.json) {
      emitResult(ctx, { text, tags, tail: ctx.tail })
      return
    }
    write(`${text}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}\n`)
  },
} satisfies CommandModule
