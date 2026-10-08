/**
 * Recipes: a procedure written as front matter plus prose, run in this process
 * so a step is the same code path as the command an operator would type.
 *
 *   ---
 *   name: host-health
 *   params:
 *     host: { default: uq-observability }
 *   steps:
 *     - id: load
 *       run: crafty ssh health {{params.host}} --json
 *   ---
 *   # Host health
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote, splitArgv } from '../argv.ts'
import { resolveCommand, run, setOutputSink } from 'crafty'
import { ConfigError, OpsError, usageError } from 'crafty'
import { expandHome } from '../targets.ts'
import { isTable } from '../values.ts'
import hostHealth from '../../recipes/host-health.md' with { type: 'text' }

export interface RecipeParam {
  name: string
  default?: string
  description?: string
}

export interface RecipeStep {
  id: string
  run: string[]
  quiet: boolean
  continueOnError: boolean
}

export interface Recipe {
  name: string
  description: string
  params: RecipeParam[]
  steps: RecipeStep[]
  prose: string
  path: string
}

export interface StepOutcome {
  id: string
  argv: string[]
  exit_code: number
  duration_ms: number
  stdout: string
}

/** Client-owned default recipe, used when no scanned file defines its name. */
const EMBEDDED: Array<{ name: string; path: string; text: string }> = [
  { name: 'host-health', path: 'embedded://host-health.md', text: hostHealth },
]

const ALLOWED_TOP = ['name', 'description', 'params', 'steps']
const ALLOWED_STEP = ['id', 'run', 'quiet', 'continue_on_error']
const ALLOWED_PARAM = ['default', 'description']

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

export function splitFrontMatter(text: string): { front: string; prose: string } {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return { front: '', prose: text }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) return { front: '', prose: text }
  return { front: lines.slice(1, end).join('\n'), prose: lines.slice(end + 1).join('\n').trim() }
}

export function parseRecipe(text: string, path: string): Recipe {
  const { front, prose } = splitFrontMatter(text)
  const problems: string[] = []
  if (front.trim() === '') {
    throw new ConfigError([`${path}: no front matter; a recipe starts with --- and its YAML`], path)
  }

  let doc: unknown
  try {
    doc = Bun.YAML.parse(front)
  } catch (error) {
    throw new ConfigError([`${path}: the front matter is not valid YAML: ${(error as Error).message}`], path)
  }
  if (!isTable(doc)) throw new ConfigError([`${path}: the front matter must be a table`], path)

  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP.includes(key)) problems.push(`${path}: unknown front matter key "${key}"`)
  }

  const name = typeof doc['name'] === 'string' && doc['name'] !== '' ? doc['name'] : undefined
  if (name === undefined) problems.push(`${path}: front matter needs a name`)

  const params = readParams(doc['params'], path, problems)
  const steps = readSteps(doc['steps'], path, params, problems)

  if (problems.length > 0) throw new ConfigError(problems, path)
  return {
    name: name!,
    description: typeof doc['description'] === 'string' ? doc['description'] : '',
    params,
    steps,
    prose,
    path,
  }
}

function readParams(raw: unknown, path: string, problems: string[]): RecipeParam[] {
  if (raw === undefined) return []
  if (!isTable(raw)) {
    problems.push(`${path}: params must be a table of names`)
    return []
  }
  const params: RecipeParam[] = []
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      params.push({ name, default: value })
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      params.push({ name, default: String(value) })
      continue
    }
    if (!isTable(value)) {
      problems.push(`${path}: param "${name}" must be a default value or a table with default/description`)
      continue
    }
    for (const key of Object.keys(value)) {
      if (!ALLOWED_PARAM.includes(key)) problems.push(`${path}: param "${name}" has unknown key "${key}"`)
    }
    const fallback = value['default']
    if (fallback !== undefined && typeof fallback !== 'string' && typeof fallback !== 'number' && typeof fallback !== 'boolean') {
      problems.push(`${path}: param "${name}" has a default that is not a scalar`)
    }
    params.push({
      name,
      ...(fallback === undefined ? {} : { default: String(fallback) }),
      ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
    })
  }
  return params
}

function readSteps(raw: unknown, path: string, params: RecipeParam[], problems: string[]): RecipeStep[] {
  if (!Array.isArray(raw)) {
    problems.push(raw === undefined ? `${path}: a recipe needs at least one step` : `${path}: steps must be a list`)
    return []
  }
  if (raw.length === 0) {
    problems.push(`${path}: a recipe needs at least one step`)
    return []
  }

  const steps: RecipeStep[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const where = `${path}: step ${index + 1}`
    if (!isTable(entry)) {
      problems.push(`${where}: must be a table with id and run`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!ALLOWED_STEP.includes(key)) problems.push(`${where}: unknown key "${key}"`)
    }
    const id = typeof entry['id'] === 'string' ? entry['id'] : undefined
    if (id === undefined || id === '') {
      problems.push(`${where}: needs an id`)
      continue
    }
    if (seen.has(id)) {
      problems.push(`${path}: duplicate step id "${id}"`)
      continue
    }
    seen.add(id)
    const argv = readRun(entry['run'], `${where} (${id})`, problems)
    if (argv === undefined) continue
    if (argv.length === 0) {
      problems.push(`${where} (${id}): run is empty`)
      continue
    }
    if (argv[0] === 'recipe') {
      problems.push(`${where} (${id}): a step cannot run another recipe`)
      continue
    }
    if (resolveCommand(argv[0]!) === undefined) {
      problems.push(`${where} (${id}): unknown command "${argv[0]}"`)
      continue
    }
    checkReferences(argv, `${where} (${id})`, params, steps, problems)
    steps.push({
      id,
      run: argv,
      quiet: entry['quiet'] === true,
      continueOnError: entry['continue_on_error'] === true,
    })
  }
  return steps
}

function readRun(raw: unknown, where: string, problems: string[]): string[] | undefined {
  if (typeof raw === 'string') {
    try {
      return stripProgram(splitArgv(raw))
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`)
      return undefined
    }
  }
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')) {
    return stripProgram(raw as string[])
  }
  problems.push(`${where}: run must be a string or a list of strings`)
  return undefined
}

function stripProgram(argv: string[]): string[] {
  return argv[0] === 'crafty' || argv[0] === 'ops' ? argv.slice(1) : argv
}

/** Param and step references are checked when the file loads, not mid-run. */
function checkReferences(
  argv: string[],
  where: string,
  params: RecipeParam[],
  earlier: RecipeStep[],
  problems: string[],
): void {
  const declared = params.map((param) => param.name)
  for (const token of argv) {
    for (const [, expression] of token.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
      const text = expression!.trim()
      if (text.startsWith('params.')) {
        const wanted = text.slice('params.'.length)
        if (!declared.includes(wanted)) {
          problems.push(`${where}: references unknown param "${wanted}" (declared: ${declared.join(', ') || 'none'})`)
        }
        continue
      }
      if (text.startsWith('steps.')) {
        const wanted = text.slice('steps.'.length).split('.')[0]!
        if (!earlier.some((step) => step.id === wanted)) {
          problems.push(`${where}: references step "${wanted}", which does not run before it`)
        }
        continue
      }
      problems.push(`${where}: cannot read "{{${text}}}"; only params.* and steps.* are substituted`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/**
 * Every directory worth scanning, most specific first: `--recipes-dir` (in the
 * order given), then `$OPS_RECIPES_DIR`, then the user's own recipes, then the
 * ones that ship with the service.
 */
export function recipeDirs(explicit: string[] = [], env: Record<string, string | undefined> = process.env): string[] {
  const dirs = [...explicit]
  const fromEnv = env['OPS_RECIPES_DIR']
  if (fromEnv !== undefined && fromEnv !== '') dirs.push(fromEnv)
  dirs.push(join(homedir(), '.config', 'ops-cli', 'recipes'))
  dirs.push(join(import.meta.dir, '..', '..', 'recipes'))
  return dirs.map(expandHome)
}

/** The first definition of a name wins across directories; one directory cannot repeat it. */
export function discoverRecipes(dirs: string[]): Recipe[] {
  const recipes = new Map<string, Recipe>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const seenHere = new Map<string, string>()
    for (const file of markdownFiles(dir)) {
      const recipe = parseRecipe(readFileSync(file, 'utf8'), file)
      const duplicate = seenHere.get(recipe.name)
      if (duplicate !== undefined) {
        throw new ConfigError(
          [`${file}: recipe name "${recipe.name}" is already defined by ${duplicate}`, 'recipe names must be unique'],
          file,
        )
      }
      seenHere.set(recipe.name, file)
      if (!recipes.has(recipe.name)) recipes.set(recipe.name, recipe)
    }
  }

  for (const embedded of EMBEDDED) {
    if (recipes.has(embedded.name)) continue
    recipes.set(embedded.name, parseRecipe(embedded.text, embedded.path))
  }
  return [...recipes.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function markdownFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path)
    }
  }
  walk(dir)
  return found.sort()
}

export function findRecipe(name: string, dirs: string[]): Recipe {
  const all = discoverRecipes(dirs)
  const found = all.find((recipe) => recipe.name === name)
  if (found === undefined) {
    throw new OpsError(`no recipe named "${name}"`, 'not-found', {
      hint: `known recipes: ${all.map((recipe) => recipe.name).join(', ') || 'none'}`,
    })
  }
  return found
}

/* ------------------------------------------------------------------ *
 * Substitution
 * ------------------------------------------------------------------ */

export interface Substitutions {
  params: Record<string, string>
  steps: Map<string, StepOutcome>
}

/** A placeholder for a literal `{{`, which must survive the pass below. */
const LITERAL = '\u0000'

export function substitute(text: string, substitutions: Substitutions): string {
  if (!text.includes('{{') && !text.includes('\\{{')) return text
  const prepared = text.replaceAll('\\{{', LITERAL)
  const out = prepared.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_match, expression: string) => resolve(expression, substitutions))
  return out.replaceAll(LITERAL, '{{')
}

function resolve(expression: string, substitutions: Substitutions): string {
  const text = expression.trim()
  if (text.startsWith('params.')) {
    const value = substitutions.params[text.slice('params.'.length)]
    if (value === undefined) throw usageError(`no value for {{${text}}}`)
    return value
  }

  if (text.startsWith('steps.')) {
    const rest = text.slice('steps.'.length)
    const [id, ...path] = rest.split('.')
    const outcome = id === undefined ? undefined : substitutions.steps.get(id)
    if (outcome === undefined) {
      throw usageError(`{{${text}}} refers to a step that has not run`, `known steps: ${[...substitutions.steps.keys()].join(', ') || 'none'}`)
    }
    if (path.length === 0) throw usageError(`{{${text}}} needs stdout, json or exit_code`)
    const [field, ...dotted] = path
    if (field === 'exit_code') return String(outcome.exit_code)
    if (field === 'stdout' && dotted.length === 0) return outcome.stdout.replace(/\s+$/, '')
    if (field === 'json') {
      const parsed = parseStepJson(outcome, text)
      if (dotted.length === 0) return JSON.stringify(parsed)
      return stringify(walk(parsed, dotted, outcome.id, dotted.join('.')))
    }
    throw usageError(`{{${text}}} is not one of stdout, json or exit_code`)
  }

  throw usageError(`cannot read {{${text}}}`, 'only {{params.*}} and {{steps.*}} are substituted')
}

function parseStepJson(outcome: StepOutcome, expression: string): unknown {
  try {
    return JSON.parse(outcome.stdout)
  } catch {
    throw new OpsError(`step ${outcome.id} did not print JSON, so {{${expression}}} cannot be read`, 'usage', {
      hint: 'give the step `--json`',
    })
  }
}

function walk(value: unknown, path: string[], stepId: string, expression: string): unknown {
  let current = value
  for (const key of path) {
    const index = Array.isArray(current) ? Number(key) : Number.NaN
    if (Array.isArray(current) && Number.isInteger(index) && index >= 0 && index < current.length) {
      current = current[index]
      continue
    }
    if (isTable(current) && key in current) {
      current = current[key]
      continue
    }
    throw new OpsError(`step ${stepId} has no "${expression}"`, 'not-found', {
      hint: `the JSON it printed has: ${describeKeys(current)}`,
    })
  }
  return current
}

function describeKeys(value: unknown): string {
  if (Array.isArray(value)) return `an array of ${value.length}`
  if (isTable(value)) return Object.keys(value).slice(0, 12).join(', ')
  return `a ${typeof value}`
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

export interface RunOptions {
  /** The resolved parameter values a step substitutes in. */
  values: Record<string, string>
  /** Passed on to a step whose command declares --yes. */
  yes: boolean
  /** Echo each step's stdout as it lands. */
  echo: (step: RecipeStep, outcome: StepOutcome) => void
}

export interface RunOutcome {
  steps: StepOutcome[]
  /** 0 unless a step failed without continue_on_error. */
  exitCode: number
  /** The failure that stopped the run, if one did. */
  failed: StepOutcome | null
  /** Steps that failed but were allowed to keep going. */
  tolerated: StepOutcome[]
}

/** Only the declared defaults, for showing a recipe that cannot run yet. */
export function defaultParams(recipe: Recipe): Record<string, string> {
  return Object.fromEntries(
    recipe.params.flatMap((param) => (param.default === undefined ? [] : [[param.name, param.default]])),
  )
}

export function resolveParams(recipe: Recipe, given: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(given)) {
    if (!recipe.params.some((param) => param.name === name)) {
      throw usageError(
        `recipe ${recipe.name} has no param "${name}"`,
        `params: ${recipe.params.map((param) => param.name).join(', ') || 'none'}`,
      )
    }
    values[name] = value
  }
  for (const param of recipe.params) {
    if (values[param.name] !== undefined) continue
    if (param.default === undefined) {
      throw usageError(`recipe ${recipe.name} needs --param ${param.name}=<value>`, param.description)
    }
    values[param.name] = param.default
  }
  return values
}

export async function runRecipe(recipe: Recipe, options: RunOptions): Promise<RunOutcome> {
  const values = resolveParams(recipe, options.values)
  const steps = new Map<string, StepOutcome>()
  const outcomes: StepOutcome[] = []

  for (const step of recipe.steps) {
    const argv = step.run.map((token) => substitute(token, { params: values, steps }))
    if (options.yes && declaresYes(argv[0])) argv.push('--yes')

    let captured = ''
    const outer = setOutputSink((text) => {
      captured += text
    })
    const startedAt = Date.now()
    let exitCode: number
    try {
      exitCode = await run(argv)
    } finally {
      setOutputSink(outer)
    }

    const outcome: StepOutcome = { id: step.id, argv, exit_code: exitCode, duration_ms: Date.now() - startedAt, stdout: captured }
    steps.set(step.id, outcome)
    outcomes.push(outcome)
    options.echo(step, outcome)

    if (exitCode !== 0 && !step.continueOnError) {
      return { steps: outcomes, exitCode, failed: outcome, tolerated: [] }
    }
  }

  // continue_on_error means the failure is recorded, not fatal.
  return { steps: outcomes, exitCode: 0, failed: null, tolerated: outcomes.filter((outcome) => outcome.exit_code !== 0) }
}

/** Only a step that declares --yes may be handed one. */
function declaresYes(command: string | undefined): boolean {
  if (command === undefined) return false
  const resolved = resolveCommand(command)
  return resolved?.options?.some((entry) => entry.name === 'yes') === true
}

/**
 * What each step would run. Parameters are resolved; `{{steps.*}}` is left
 * alone, because nothing has run to fill it in.
 */
export function previewRecipe(recipe: Recipe, values: Record<string, string>): string[] {
  return recipe.steps.map((step) =>
    shellQuote(
      step.run.map((token) =>
        token.replace(/\{\{\s*params\.([^}\s]+)\s*\}\}/g, (match, name: string) => values[name] ?? match),
      ),
    ),
  )
}
