import { emitResult, usageError, writeErr, type Ctx, type CommandModule } from 'crafty'

/** Progress markers are diagnostics: they appear only with `--verbose`. */
const mark = (ctx: Ctx, text: string): void => {
  if (ctx.verbose) writeErr(`demo: ${text}\n`)
}

/**
 * The framework shape in one file: a nested static route, a captured
 * `:parameter`, and init/destroy hooks around the selected leaf. Hooks share the
 * invocation's `ctx.state` with the handler and run outermost to innermost on
 * the way in, reverse on the way out.
 */
export default {
  name: 'demo',
  summary: 'Nested routes, a captured parameter and lifecycle hooks',
  init(ctx) {
    mark(ctx, 'init')
  },
  destroy(ctx) {
    mark(ctx, 'destroy')
  },
  commands: {
    task: {
      summary: 'Work on the task named by the next argument',
      init(ctx) {
        mark(ctx, 'task:init')
      },
      destroy(ctx) {
        mark(ctx, 'task:destroy')
      },
      commands: {
        ':name': {
          init(ctx) {
            ctx.state.task = { name: ctx.params.name, openedAt: Date.now() }
            mark(ctx, `task ${ctx.params.name}:init`)
          },
          destroy(ctx) {
            mark(ctx, `task ${ctx.params.name}:destroy`)
          },
          commands: {
            show(ctx) {
              emitResult(ctx, { task: ctx.state.task, args: ctx.positionals, tail: ctx.tail })
            },
            fail() {
              throw usageError('the task cannot be closed', 'demo task fail exists to show a usage error')
            },
          },
        },
      },
    },
  },
} satisfies CommandModule
