/**
 * `crafty recipe`: list, read and run the procedures in the recipe directories.
 */
import { emitEnvelope, emitResult, flag, write, writeErr } from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { usageError } from 'crafty'
import { formatDuration } from '../lib/time.ts'
import { defaultParams, discoverRecipes, findRecipe, previewRecipe, recipeDirs, resolveParams, runRecipe } from '../lib/recipes/engine.ts'
import type { Recipe } from '../lib/recipes/engine.ts'

function dirsFrom(ctx: Ctx): string[] {
  return recipeDirs(ctx.repeat['recipes-dir'] ?? [])
}

function recipeName(ctx: Ctx): string {
  const name = ctx.positionals[0]
  if (name === undefined) throw usageError('the recipe name is required', 'run `crafty recipe list` to see them')
  return name
}

function paramsFrom(ctx: Ctx): Record<string, string> {
  const given: Record<string, string> = {}
  for (const entry of ctx.repeat['param'] ?? []) {
    const separator = entry.indexOf('=')
    if (separator <= 0) throw usageError(`--param wants name=value, got "${entry}"`)
    given[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return given
}

function signature(recipe: Recipe): string {
  return recipe.params.map((param) => (param.default === undefined ? `${param.name}=?` : `${param.name}=${param.default}`)).join(' ')
}

const listVerb: CommandNode = {
  summary: 'List the recipes this machine can run',
  usage: [
    'crafty recipe list [options]',
    '',
    'Recipes are read from --recipes-dir, then $OPS_RECIPES_DIR, then',
    '~/.config/ops-cli/recipes, then the ones that ship with the service. The',
    'first directory that defines a name wins.',
    '',
    'Options:',
    '  --recipes-dir <path>  Look here first (repeatable)',
    '  --json                Print the envelope',
    '  -h, --help            Show this message',
  ],
  repeatable: ['recipes-dir'],
  options: [{ name: 'recipes-dir', type: 'string' }],
  run: async (ctx) => {
    const recipes = discoverRecipes(dirsFrom(ctx))
    const rows = recipes.map((recipe) => ({
      name: recipe.name,
      description: recipe.description,
      params: signature(recipe),
      steps: recipe.steps.length,
      path: recipe.path,
    }))
    emitResult(ctx, rows, { columns: ['name', 'description', 'params', 'steps', 'path'], truncated: false })
    return 0
  },
}

const showVerb: CommandNode = {
  summary: 'Show one recipe: its steps, its prose and its defaults',
  usage: [
    'crafty recipe show <name> [options]',
    '',
    'The whole recipe, including `--dry-run`-style step templates with the',
    'parameters still in place.',
    '',
    'Options:',
    '  --recipes-dir <path>  Look here first (repeatable)',
    '  --json                Print the envelope',
    '  -h, --help            Show this message',
  ],
  repeatable: ['recipes-dir'],
  options: [{ name: 'recipes-dir', type: 'string' }],
  run: async (ctx) => {
    const recipe = findRecipe(recipeName(ctx), dirsFrom(ctx))
    if (ctx.json || ctx.format !== 'auto') {
      emitResult(
        ctx,
        {
          name: recipe.name,
          description: recipe.description,
          params: recipe.params,
          steps: recipe.steps,
          prose: recipe.prose,
          path: recipe.path,
        },
        { truncated: false },
      )
      return 0
    }
    write(`${recipe.name}  ${recipe.description}\n`)
    write(`${recipe.path}\n`)
    if (recipe.params.length > 0) {
      write('\nparams\n')
      for (const param of recipe.params) {
        write(`  ${param.name.padEnd(8)}  ${param.default ?? '(required)'}${param.description === undefined ? '' : `  ${param.description}`}\n`)
      }
    }
    write('\nsteps\n')
    const previews = previewRecipe(recipe, defaultParams(recipe))
    recipe.steps.forEach((step, index) => {
      write(`  ${step.id.padEnd(12)}  ${previews[index]}\n`)
      if (step.continueOnError) write(`  ${''.padEnd(12)}  (continues if it fails)\n`)
    })
    if (recipe.prose !== '') write(`\n${recipe.prose}\n`)
    return 0
  },
}

const runVerb: CommandNode = {
  summary: 'Run a recipe step by step, in this process',
  usage: [
    'crafty recipe run <name> [--param name=value]... [options]',
    '',
    'Each step is dispatched exactly as if you had typed it, with {{params.*}}',
    'and {{steps.*}} filled in. Steps run in order and stop at the first',
    'failure, unless the step sets continue_on_error. --yes is passed on to the',
    'steps that accept it, so a recipe containing writes still refuses to run',
    'without it.',
    '',
    'Options:',
    '  --param <name=value>  Set a parameter (repeatable)',
    '  --recipes-dir <path>  Look here first (repeatable)',
    '  --dry-run             Print the resolved commands, run nothing',
    '  --yes                 Allow steps that change remote state',
    '  --json                Print the envelope, steps included',
    '  -h, --help            Show this message',
  ],
  repeatable: ['param', 'recipes-dir'],
  options: [
    { name: 'param', type: 'string' },
    { name: 'recipes-dir', type: 'string' },
    { name: 'dry-run', type: 'boolean' },
    { name: 'yes', type: 'boolean' },
  ],
  run: async (ctx) => {
    const recipe = findRecipe(recipeName(ctx), dirsFrom(ctx))
    const values = resolveParams(recipe, paramsFrom(ctx))

    if (flag(ctx.values, 'dry-run')) {
      const plan = previewRecipe(recipe, values)
      if (ctx.json) {
        emitResult(ctx, { recipe: recipe.name, steps: plan.map((argv, index) => ({ id: recipe.steps[index]?.id, argv })) }, { truncated: false })
        return 0
      }
      for (const argv of plan) write(`${argv}\n`)
      return 0
    }

    const outcome = await runRecipe(recipe, {
      values,
      yes: flag(ctx.values, 'yes'),
      echo: (step, result) => {
        if (ctx.json || ctx.format !== 'auto') return
        writeErr(`== ${step.id} (exit ${result.exit_code}, ${formatDuration(result.duration_ms)})\n`)
        if (!step.quiet) write(result.stdout)
      },
    })

    ctx.target = recipe.name
    if (ctx.json) {
      emitEnvelope({
        ok: outcome.failed === null,
        source: 'recipe',
        target: recipe.name,
        data: { recipe: recipe.name, steps: outcome.steps },
        meta: {
          truncated: false,
          duration_ms: Date.now() - ctx.startedAt,
          count: outcome.steps.length,
          tolerated: outcome.tolerated.map((step) => step.id),
        },
        ...(outcome.failed === null
          ? {}
          : {
              error: {
                kind: 'remote',
                message: `step ${outcome.failed.id} exited ${outcome.failed.exit_code}`,
                status: outcome.failed.exit_code,
                hint: `it ran: ${outcome.failed.argv.join(' ')}`,
              },
            }),
      })
      return outcome.exitCode
    }

    if (outcome.failed !== null) {
      writeErr(`recipe ${recipe.name}: step ${outcome.failed.id} exited ${outcome.failed.exit_code}\n`)
      writeErr(`hint: it ran: ${outcome.failed.argv.join(' ')}\n`)
    } else if (outcome.tolerated.length > 0) {
      writeErr(
        `recipe ${recipe.name}: ${outcome.steps.length} step(s), ${outcome.tolerated.length} tolerated failure(s): ${outcome.tolerated
          .map((step) => step.id)
          .join(', ')}\n`,
      )
    } else {
      writeErr(`recipe ${recipe.name}: ${outcome.steps.length} step(s), all exit 0 (${formatDuration(Date.now() - ctx.startedAt)})\n`)
    }
    return outcome.exitCode
  },
}

const recipeCommand = {
  name: 'recipe',
  summary: 'Run the guided procedures in the recipe directories',
  source: 'recipe',
  commands: {
    list: listVerb,
    show: showVerb,
    run: runVerb,
  },
} satisfies CommandModule

export default recipeCommand
