import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, OpsError } from 'crafty'
import {
  defaultParams,
  discoverRecipes,
  findRecipe,
  parseRecipe,
  previewRecipe,
  recipeDirs,
  resolveParams,
  runRecipe,
  splitFrontMatter,
  substitute,
} from '../lib/recipes/engine.ts'
import type { StepOutcome } from '../lib/recipes/engine.ts'
import { loadCommands } from 'crafty'
import { resetConfigCache } from '../lib/targets.ts'
import recipeCommand from '../commands/recipe.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { installFakeSsh, type FakeSsh } from './helpers/fake-ssh.ts'
import { startMockServer } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-recipes-'))
let ssh: FakeSsh
let counter = 0

function tempDir(name: string): string {
  counter += 1
  const dir = join(scratch, `${name}-${counter}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeRecipe(dir: string, file: string, text: string): string {
  const path = join(dir, file)
  writeFileSync(path, text)
  return path
}

function problems(text: string): string[] {
  try {
    parseRecipe(text, 'demo.md')
    return []
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
}

// Recipe steps use the same discovered registry as direct commands.
await loadCommands(new URL('../commands/', import.meta.url))

beforeAll(() => {
  ssh = installFakeSsh()
})

afterAll(() => {
  ssh.restore()
  rmSync(scratch, { recursive: true, force: true })
})

const SETTINGS_CONFIG = join(scratch, 'settings.yml')
writeFileSync(
  SETTINGS_CONFIG,
  ['settings:', '  timeout_ms: 15000', 'ssh:', '  hosts:', '    - uq-observability', ''].join('\n'),
)

beforeEach(() => {
  ssh.reset()
  process.env['OPS_CONFIG'] = SETTINGS_CONFIG
})

afterEach(() => {
  delete process.env['OPS_CONFIG']
  resetConfigCache()
})

const SIMPLE = `---
name: demo
description: A demo
params:
  host: { default: uq-observability, description: SSH alias }
steps:
  - id: one
    run: ssh run {{params.host}} -- hostname
  - id: two
    run: ssh ps {{params.host}} --json
---
Prose about the demo.
`

describe('parsing', () => {
  test('reads the front matter and keeps the prose', () => {
    const recipe = parseRecipe(SIMPLE, 'demo.md')
    expect(recipe.name).toBe('demo')
    expect(recipe.description).toBe('A demo')
    expect(recipe.params).toEqual([{ name: 'host', default: 'uq-observability', description: 'SSH alias' }])
    expect(recipe.steps).toEqual([
      { id: 'one', run: ['ssh', 'run', '{{params.host}}', '--', 'hostname'], quiet: false, continueOnError: false },
      { id: 'two', run: ['ssh', 'ps', '{{params.host}}', '--json'], quiet: false, continueOnError: false },
    ])
    expect(recipe.prose).toBe('Prose about the demo.')
  })

  test('the prose is documentation, never interpreted', () => {
    const recipe = parseRecipe(`---\nname: x\nsteps:\n  - id: a\n    run: ssh hosts\n---\nRun {{params.nope}} now\n`, 'x.md')
    expect(recipe.prose).toContain('{{params.nope}}')
    expect(discoverRecipes([]).length).toBeGreaterThan(0)
  })

  test('run accepts lists and drops leading ops or crafty program names', () => {
    const recipe = parseRecipe(
      [
        '---',
        'name: x',
        'steps:',
        '  - id: a',
        '    run: [ops, ssh, hosts]',
        '    quiet: true',
        '  - id: b',
        '    run: crafty ssh df uq-observability',
        '    continue_on_error: true',
        '---',
        '',
      ].join('\n'),
      'x.md',
    )
    expect(recipe.steps[0]).toEqual({ id: 'a', run: ['ssh', 'hosts'], quiet: true, continueOnError: false })
    expect(recipe.steps[1]?.continueOnError).toBe(true)
  })

  test('a file with no front matter is refused', () => {
    expect(problems('# just prose\n')).toEqual(['demo.md: no front matter; a recipe starts with --- and its YAML'])
  })

  test('a name is required', () => {
    expect(problems('---\nsteps:\n  - id: a\n    run: ssh hosts\n---\n')).toEqual(['demo.md: front matter needs a name'])
  })

  test('typos are caught: unknown keys anywhere', () => {
    expect(problems('---\nname: x\nverb: y\nsteps:\n  - id: a\n    run: ssh hosts\n    loud: yes\n---\n')).toEqual([
      'demo.md: unknown front matter key "verb"',
      'demo.md: step 1: unknown key "loud"',
    ])
  })

  test('steps are checked as a whole: ids, verbs, references', () => {
    expect(
      problems(
        [
          '---',
          'name: x',
          'params:',
          '  host: { default: h }',
          'steps:',
          '  - id: a',
          '    run: ssh hosts',
          '  - id: a',
          '    run: nope whatever',
          '  - id: c',
          '    run: ssh df {{params.other}}',
          '  - id: d',
          '    run: ssh logs {{params.host}} --file {{steps.z.stdout}}',
          '  - id: e',
          '    run: recipe run other',
          '---',
        ].join('\n'),
      ),
    ).toEqual([
      'demo.md: duplicate step id "a"',
      'demo.md: step 3 (c): references unknown param "other" (declared: host)',
      'demo.md: step 4 (d): references step "z", which does not run before it',
      'demo.md: step 5 (e): a step cannot run another recipe',
    ])
  })

  test('a step with no run, or an unreadable one, is refused', () => {
    expect(problems('---\nname: x\nsteps:\n  - id: a\n---\n')).toEqual(['demo.md: step 1 (a): run must be a string or a list of strings'])
    expect(problems('---\nname: x\nsteps:\n  - id: a\n    run: "ssh logs --grep \'unterminated"\n---\n')).toEqual([
      'demo.md: step 1 (a): unterminated single quote in "ssh logs --grep \'unterminated"',
    ])
    expect(problems('---\nname: x\nsteps: []\n---\n')).toEqual(['demo.md: a recipe needs at least one step'])
    expect(problems('---\nname: x\n---\n')).toEqual(['demo.md: a recipe needs at least one step'])
  })

  test('front matter has to be YAML', () => {
    expect(problems('---\nname: [unclosed\n---\n')[0]).toContain('the front matter is not valid YAML')
  })

  test('splitFrontMatter leaves a file without one untouched', () => {
    expect(splitFrontMatter('hello')).toEqual({ front: '', prose: 'hello' })
    expect(splitFrontMatter('---\nname: x\n---\nbody')).toEqual({ front: 'name: x', prose: 'body' })
  })
})

describe('discovery', () => {
  test('the first directory that defines a name wins', () => {
    const first = tempDir('first')
    const second = tempDir('second')
    writeRecipe(first, 'a.md', '---\nname: shared\ndescription: from first\nsteps:\n  - id: a\n    run: ssh hosts\n---\n')
    writeRecipe(second, 'b.md', '---\nname: shared\ndescription: from second\nsteps:\n  - id: a\n    run: ssh hosts\n---\n')
    const found = discoverRecipes([first, second]).filter((recipe) => recipe.name === 'shared')
    expect(found).toHaveLength(1)
    expect(found[0]?.description).toBe('from first')
  })

  test('the same name twice in one directory is a configuration problem', () => {
    const dir = tempDir('dupes')
    writeRecipe(dir, 'a.md', '---\nname: same\nsteps:\n  - id: a\n    run: ssh hosts\n---\n')
    writeRecipe(dir, 'b.md', '---\nname: same\nsteps:\n  - id: a\n    run: ssh hosts\n---\n')
    expect(() => discoverRecipes([dir])).toThrow(ConfigError)
    try {
      discoverRecipes([dir])
    } catch (error) {
      expect((error as ConfigError).problems[0]).toContain('recipe name "same" is already defined by')
    }
  })

  test('recipes nest, and the directory order follows the flags, env and defaults', () => {
    const dir = tempDir('nested')
    mkdirSync(join(dir, 'ops'), { recursive: true })
    writeRecipe(join(dir, 'ops'), 'deep.md', '---\nname: deep\nsteps:\n  - id: a\n    run: ssh hosts\n---\n')
    expect(discoverRecipes([dir]).map((recipe) => recipe.name)).toContain('deep')

    const dirs = recipeDirs(['/explicit'], { OPS_RECIPES_DIR: '/env', XDG_CONFIG_HOME: '/xdg' })
    expect(dirs[0]).toBe('/explicit')
    expect(dirs[1]).toBe('/env')
    expect(dirs[2]).toBe(`${process.env['HOME']}/.config/ops-cli/recipes`)
    expect(dirs[3]?.endsWith('/recipes')).toBe(true)
  })

  test('the shipped recipe is available even when no directory has one', () => {
    const recipes = discoverRecipes([tempDir('empty')])
    expect(recipes.map((recipe) => recipe.name)).toEqual(['host-health'])
    expect(recipes[0]?.path).toBe('embedded://host-health.md')
    expect(recipes[0]?.steps.map((step) => step.id)).toEqual(['identity', 'load', 'disk'])
  })

  test('a missing recipe is a not-found failure', () => {
    try {
      findRecipe('nope', [tempDir('none')])
      throw new Error('expected OpsError')
    } catch (error) {
      expect(error).toBeInstanceOf(OpsError)
      expect((error as OpsError).kind).toBe('not-found')
    }
  })
})

describe('parameters', () => {
  const recipe = parseRecipe(SIMPLE, 'demo.md')

  test('defaults are filled in and overrides win', () => {
    expect(resolveParams(recipe, {})).toEqual({ host: 'uq-observability' })
    expect(resolveParams(recipe, { host: 'uq-ingress-controller' })).toEqual({ host: 'uq-ingress-controller' })
    expect(defaultParams(recipe)).toEqual({ host: 'uq-observability' })
  })

  test('a param with no default is required, and its description is the hint', () => {
    const needed = parseRecipe(
      '---\nname: x\nparams:\n  app: { description: the service name }\nsteps:\n  - id: a\n    run: ssh run {{params.app}} -- hostname\n---\n',
      'x.md',
    )
    try {
      resolveParams(needed, {})
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('usage')
    }
    expect(defaultParams(needed)).toEqual({})
  })

  test('an undeclared param is refused', () => {
    try {
      resolveParams(recipe, { nope: '1' })
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('usage')
    }
  })
})

describe('substitution', () => {
  const outcome = (id: string, stdout: string, exit_code = 0): StepOutcome => ({
    id,
    argv: ['ssh'],
    exit_code,
    duration_ms: 1,
    stdout,
  })
  const steps = new Map<string, StepOutcome>([
    ['one', outcome('one', 'uqcraft101\n')],
    [
      'two',
      outcome(
        'two',
        JSON.stringify({
          ok: true,
          source: 'ssh',
          data: { load: { '1m': 0.49 }, disks: [{ mount: '/' }, { mount: '/boot' }] },
        }),
      ),
    ],
    ['fail', outcome('fail', '', 3)],
  ])
  const substitutions = { params: { host: 'uq-observability', spaced: 'two words' }, steps }

  test('params, stdout, exit codes', () => {
    expect(substitute('ssh run {{params.host}} -- hostname', substitutions)).toBe('ssh run uq-observability -- hostname')
    expect(substitute('{{params.spaced}}', substitutions)).toBe('two words')
    expect(substitute('{{steps.one.stdout}}', substitutions)).toBe('uqcraft101')
    expect(substitute('{{steps.fail.exit_code}}', substitutions)).toBe('3')
  })

  test('json, including dotted paths and numeric indices', () => {
    expect(substitute('{{steps.two.json.data.load.1m}}', substitutions)).toBe('0.49')
    expect(substitute('{{steps.two.json.data.disks.1.mount}}', substitutions)).toBe('/boot')
    expect(substitute('{{steps.two.json.data.disks}}', substitutions)).toBe('[{"mount":"/"},{"mount":"/boot"}]')
    expect(substitute('{{steps.two.json.ok}}', substitutions)).toBe('true')
    expect(substitute('{{steps.two.json}}', substitutions)).toBe(
      JSON.stringify({ ok: true, source: 'ssh', data: { load: { '1m': 0.49 }, disks: [{ mount: '/' }, { mount: '/boot' }] } }),
    )
  })

  test('a missing JSON path is a not-found failure', () => {
    try {
      substitute('{{steps.two.json.data.nope}}', substitutions)
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('not-found')
    }
  })

  test('a step that is not JSON, or not run yet, is a usage error', () => {
    try {
      substitute('{{steps.one.json}}', substitutions)
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('usage')
    }
    try {
      substitute('{{steps.later.stdout}}', substitutions)
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('usage')
    }
  })

  test('an unknown expression is refused, and \\{{ stays literal', () => {
    expect(() => substitute('{{nope}}', substitutions)).toThrow(OpsError)
    expect(() => substitute('{{steps.one.nope}}', substitutions)).toThrow(OpsError)
    expect(substitute('echo \\{{params.host}}', substitutions)).toBe('echo {{params.host}}')
    expect(substitute('plain text', substitutions)).toBe('plain text')
  })
})

describe('running', () => {
  test('steps run in order and their stdout is captured', async () => {
    ssh.reply('uqcraft101\n')
    const recipe = parseRecipe(SIMPLE, 'demo.md')
    const echoed: string[] = []
    const outcome = await runRecipe(recipe, {
      values: { host: 'uq-observability' },
      yes: false,
      echo: (step) => echoed.push(step.id),
    })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.failed).toBeNull()
    expect(outcome.steps.map((step) => step.id)).toEqual(['one', 'two'])
    expect(outcome.steps[0]?.stdout).toBe('uqcraft101\n')
    expect(outcome.steps[0]?.argv).toEqual(['ssh', 'run', 'uq-observability', '--', 'hostname'])
    expect(echoed).toEqual(['one', 'two'])
  })

  test('a failing step stops the run and becomes the exit code', async () => {
    ssh.reply('boom\n', 'failed\n')
    ssh.replyFor('false', { exit: 3, stderr: 'failed\n' })
    const recipe = parseRecipe(
      [
        '---',
        'name: x',
        'steps:',
        '  - id: first',
        '    run: ssh run h -- false',
        '  - id: never',
        '    run: ssh run h -- hostname',
        '---',
      ].join('\n'),
      'x.md',
    )
    const outcome = await runRecipe(recipe, { values: {}, yes: false, echo: () => {} })
    // The step's exit code is the CLI's own: 1 for a runtime failure.
    expect(outcome.exitCode).toBe(1)
    expect(outcome.steps[0]?.exit_code).toBe(1)
    expect(outcome.failed?.id).toBe('first')
    expect(outcome.steps.map((step) => step.id)).toEqual(['first'])
  })

  test('continue_on_error keeps going, and records the failure without failing the run', async () => {
    ssh.reply('ok\n')
    ssh.replyFor('false', { exit: 3 })
    const recipe = parseRecipe(
      [
        '---',
        'name: x',
        'steps:',
        '  - id: first',
        '    run: ssh run h -- false',
        '    continue_on_error: true',
        '  - id: second',
        '    run: ssh run h -- hostname',
        '---',
      ].join('\n'),
      'x.md',
    )
    const outcome = await runRecipe(recipe, { values: {}, yes: false, echo: () => {} })
    expect(outcome.exitCode).toBe(0)
    expect(outcome.failed).toBeNull()
    expect(outcome.tolerated.map((step) => step.id)).toEqual(['first'])
    expect(outcome.steps.map((step) => step.id)).toEqual(['first', 'second'])
    expect(outcome.steps[0]?.exit_code).toBe(1)
    expect(outcome.steps[1]?.stdout).toBe('ok\n')
  })

  test('--yes is passed on to the commands that accept it', async () => {
    const recipe = parseRecipe(SIMPLE, 'demo.md')
    ssh.reply('ok\n')
    await runRecipe(recipe, { values: {}, yes: true, echo: () => {} })
    expect(ssh.argv()[0]?.at(-1)).toBe(`'hostname'`)
  })

  test('the preview resolves params and leaves step references alone', () => {
    const recipe = parseRecipe(
      '---\nname: x\nparams:\n  host: { default: h }\nsteps:\n  - id: a\n    run: ssh run {{params.host}} -- hostname\n  - id: b\n    run: ssh logs {{params.host}} --file {{steps.a.stdout}}\n---\n',
      'x.md',
    )
    expect(previewRecipe(recipe, defaultParams(recipe))).toEqual([
      `'ssh' 'run' 'h' '--' 'hostname'`,
      `'ssh' 'logs' 'h' '--file' '{{steps.a.stdout}}'`,
    ])
  })
})

describe('the recipe command', () => {
  function clientCapture(capture: CliCapture): Record<string, unknown> {
    return envelope(capture)
  }

  test('list, show and run through the dispatcher', async () => {
    const dir = tempDir('cli')
    writeRecipe(dir, 'demo.md', SIMPLE)
    ssh.reply('uqcraft101\n')

    const list = await runCaptured(recipeCommand, ['list', '--recipes-dir', dir, '--json'])
    const names = (clientCapture(list)['data'] as Record<string, unknown>[]).map((row) => row['name'])
    expect(names).toContain('demo')

    const show = await runCaptured(recipeCommand, ['show', 'demo', '--recipes-dir', dir, '--json'])
    expect((clientCapture(show)['data'] as Record<string, unknown>)['name']).toBe('demo')

    const run = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--json'])
    const data = clientCapture(run)['data'] as Record<string, unknown>
    expect(run.code).toBe(0)
    expect((data['steps'] as Record<string, unknown>[]).map((step) => step['exit_code'])).toEqual([0, 0])
    expect((data['steps'] as Record<string, unknown>[])[0]?.['stdout']).toBe('uqcraft101\n')
  })

  test('a failing step is reported inside the envelope, with the exit code', async () => {
    const dir = tempDir('failing')
    writeRecipe(
      dir,
      'demo.md',
      '---\nname: demo\nsteps:\n  - id: boom\n    run: ssh run h -- false\n---\n',
    )
    ssh.replyFor('false', { exit: 4, stderr: 'nope\n' })
    const capture = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--json'])
    expect(capture.code).toBe(1)
    const output = clientCapture(capture)
    expect(output['ok']).toBe(false)
    expect((output['data'] as Record<string, unknown>)['steps']).toMatchObject([{ id: 'boom', exit_code: 1 }])
    expect(output['error']).toMatchObject({ status: 1 })
  })

  test('--dry-run prints the commands and runs nothing', async () => {
    const dir = tempDir('dry')
    writeRecipe(dir, 'demo.md', SIMPLE)
    const capture = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--dry-run'])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toContain(`'ssh' 'run' 'uq-observability' '--' 'hostname'`)
    expect(ssh.argv()).toHaveLength(0)
  })

  test('--param shapes are checked, and unknown params are refused', async () => {
    const dir = tempDir('params')
    writeRecipe(dir, 'demo.md', SIMPLE)
    const malformed = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--param', 'host'])
    expect(malformed.code).toBe(2)

    const unknown = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--param', 'nope=1'])
    expect(unknown.code).toBe(2)

    const missing = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--param', 'host=other', '--dry-run'])
    expect(missing.code).toBe(0)
    expect(missing.stdout).toContain(`'ssh' 'run' 'other' '--' 'hostname'`)
  })

  test('the shipped recipe runs end to end against the fake host', async () => {
    ssh.replyFor('hostname', { stdout: 'uqcraft101\n' })
    ssh.replyFor('uptime', { stdout: ' 14:22:54 up 50 days, 1 user,  load average: 0.1, 0.2, 0.3\n' })
    ssh.replyFor('free', { stdout: 'Mem:  7423  2898  797\n' })
    ssh.replyFor('df', { stdout: 'Filesystem  Size  Used  Avail  Use%  Mounted on\n/dev/sda1  77G  16G  57G  22%  /\n' })
    const capture = await runCaptured(recipeCommand, ['run', 'host-health', '--json'])
    expect(capture.code).toBe(0)
    const steps = ((clientCapture(capture)['data'] as Record<string, unknown>)['steps'] as Record<string, unknown>[])
    expect(steps.map((step) => step['id'])).toEqual(['identity', 'load', 'disk'])
    expect(steps.every((step) => step['exit_code'] === 0)).toBe(true)
    expect(clientCapture(capture)['ok']).toBe(true)
  })

  test('a recipe name that does not exist is a not-found failure', async () => {
    const capture = await runCaptured(recipeCommand, ['run', 'nope', '--recipes-dir', tempDir('empty-run'), '--json'])
    expect(capture.code).toBe(1)
    expect(clientCapture(capture)['error']).toMatchObject({ kind: 'not-found' })
  })

  test('--yes reaches only the steps whose command declares it', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/UQ-1/comment', status: 201, body: { id: '1' } }])
    const configPath = join(scratch, 'jira-config.yml')
    writeFileSync(
      configPath,
      ['targets:', '  jira:', '    kind: jira', `    base_url: "${server.url}"`, '    auth: none', ''].join('\n'),
    )
    process.env['OPS_CONFIG'] = configPath
    resetConfigCache()

    const dir = tempDir('write')
    writeRecipe(
      dir,
      'demo.md',
      '---\nname: demo\nsteps:\n  - id: comment\n    run: jira comment UQ-1 --body hi\n---\n',
    )
    ssh.reply('ok\n')

    const refused = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--json'])
    // The step refused to write, and its exit code becomes the run's.
    expect(refused.code).toBe(2)
    expect(server.requests).toHaveLength(0)
    const steps = ((envelope(refused)['data'] as Record<string, unknown>)['steps'] as Record<string, unknown>[])
    expect(steps[0]?.['exit_code']).toBe(2)
    expect(steps[0]?.['argv']).toEqual(['jira', 'comment', 'UQ-1', '--body', 'hi'])

    const allowed = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir, '--yes', '--json'])
    expect(allowed.code).toBe(0)
    expect(server.of('POST').map((request) => request.path)).toEqual(['/rest/api/3/issue/UQ-1/comment'])
    const written = ((envelope(allowed)['data'] as Record<string, unknown>)['steps'] as Record<string, unknown>[])
    expect(written[0]?.['argv']).toEqual(['jira', 'comment', 'UQ-1', '--body', 'hi', '--yes'])
  })

  test('the human form prints step output', async () => {
    const dir = tempDir('human')
    writeRecipe(
      dir,
      'demo.md',
      '---\nname: demo\nparams:\n  host: { default: h }\nsteps:\n  - id: one\n    run: crafty ssh run {{params.host}} -- hostname\n  - id: two\n    run: ops ssh run {{params.host}} -- uptime\n---\n',
    )
    ssh.reply('uqcraft101\n')
    const capture = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toBe('uqcraft101\nuqcraft101\n')
  })

  test('a quiet step is not echoed', async () => {
    const dir = tempDir('quiet')
    writeRecipe(
      dir,
      'demo.md',
      '---\nname: demo\nsteps:\n  - id: one\n    run: ssh run h -- hostname\n    quiet: true\n---\n',
    )
    ssh.reply('uqcraft101\n')
    const capture = await runCaptured(recipeCommand, ['run', 'demo', '--recipes-dir', dir])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toBe('')
  })
})
