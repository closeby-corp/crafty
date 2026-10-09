import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { commands, loadCommands, setCommands, setOutputSink, type RegisteredCommand } from 'crafty'
import { capture, envelope } from './helpers/cli.ts'

const snapshots: RegisteredCommand[][] = []
let previousSink: ((text: string) => void) | null = null

beforeAll(async () => {
  await loadCommands(new URL('../commands/', import.meta.url))
})

beforeEach(() => {
  snapshots.push(commands())
  previousSink = setOutputSink(null)
})

afterEach(() => {
  const snapshot = snapshots.pop()
  if (snapshot) setCommands(snapshot)
  setOutputSink(previousSink)
})

const data = (result: Awaited<ReturnType<typeof capture>>): Record<string, unknown> =>
  envelope(result).data as Record<string, unknown>

describe('the example client', () => {
  test('discovers the command modules in its own commands/ directory', async () => {
    expect(commands().map((entry) => entry.name).sort()).toEqual(['completion', 'demo', 'echo', 'skills', 'version'])
    const help = await capture(['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toStartWith('crafty <command> [options]\n')
    for (const name of ['completion', 'demo', 'echo', 'skills', 'version']) expect(help.stdout).toContain(name)
  })

  test('echo joins positionals and honors flags and repeatable options', async () => {
    const plain = await capture(['echo', 'hello', 'world', '--json'])
    expect(plain.code).toBe(0)
    expect(data(plain)).toEqual({ text: 'hello world', tags: [], tail: [] })

    const flagged = await capture(['echo', 'hello', '--upper', '--tag', 'one', '--tag=two', '--json'])
    expect(flagged.code).toBe(0)
    expect(data(flagged)).toEqual({ text: 'HELLO', tags: ['one', 'two'], tail: [] })
  })

  test('a standalone -- leaves the rest of the line untouched', async () => {
    const result = await capture(['echo', 'hello', 'there', '--', '--json'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello there --json\n')
  })

  test('echo renders plain text when the envelope is not requested', async () => {
    const result = await capture(['echo', 'hi', '--tag', 'x'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hi [x]\n')
  })

  test('demo captures the dynamic parameter and shares ctx.state with the handler', async () => {
    const result = await capture(['demo', 'task', 'build', 'show', 'extra', '--json'])
    expect(result.code).toBe(0)
    const body = data(result) as { task: { name: string }; args: string[]; tail: string[] }
    expect(body.task.name).toBe('build')
    expect(body.args).toEqual(['extra'])
    expect(body.tail).toEqual([])
    expect(result.stderr).toBe('')
  })

  test('runs lifecycle hooks outermost to innermost and back, visible with --verbose', async () => {
    const result = await capture(['demo', 'task', 'build', 'show', '-v', '--json'])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe(
      ['demo: init', 'demo: task:init', 'demo: task build:init', 'demo: task build:destroy', 'demo: task:destroy', 'demo: destroy']
        .map((line) => `${line}\n`)
        .join(''),
    )
  })

  test('reports a failing leaf as a usage error after teardown', async () => {
    const result = await capture(['demo', 'task', 'build', 'fail', '-v', '--json'])
    expect(result.code).toBe(2)
    const body = envelope(result)
    expect(body.ok).toBe(false)
    expect((body.error as { kind: string }).kind).toBe('usage')
    expect(result.stderr).toContain('demo: task build:destroy')
  })

  test('help on a nested leaf runs no hooks, and an unknown child is a usage error', async () => {
    const help = await capture(['help', 'demo', 'task', 'build', 'show'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('crafty demo task build show [options]')
    expect(help.stderr).toBe('')

    const unknown = await capture(['demo', 'task', 'build', 'nope', '-v'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).not.toContain('demo: init')
  })

  test('skills list and show read the client catalog and expose JSON results', async () => {
    const listed = await capture(['skills', 'list', '--json'])
    expect(listed.code).toBe(0)
    const entries = envelope(listed).data as Array<{ name: string; description: string; path: string }>
    expect(entries.map(({ name }) => name)).toEqual(['crafty-example-workflow'])
    expect(entries[0]?.description).toContain('example Crafty client')
    expect(entries[0]?.path).toEndWith('/client/skills/crafty-example-workflow/SKILL.md')

    const shown = await capture(['skills', 'show', 'crafty-example-workflow', '--json'])
    expect(shown.code).toBe(0)
    const skill = data(shown) as { name: string; content: string }
    expect(skill.name).toBe('crafty-example-workflow')
    expect(skill.content).toContain('crafty echo hello world --json')

    const plain = await capture(['skills', 'list'])
    expect(plain.code).toBe(0)
    expect(plain.stdout).toContain('crafty-example-workflow')
  })

  test('skills installer help and JSON dry-run never execute a real installation', async () => {
    const help = await capture(['skills', 'install', '--help'])
    expect(help.code).toBe(0)
    for (const option of ['--skill', '--agent', '--global', '--copy', '--yes', '--dry-run']) {
      expect(help.stdout).toContain(option)
    }

    const preview = await capture([
      'skills', 'install', '--skill', 'crafty-example-workflow', '--agent', 'codex', '--copy', '--yes', '--dry-run', '--json',
    ])
    expect(preview.code).toBe(0)
    const result = data(preview) as { version: string; source: string; target: string; skills: string[]; agents: string[]; argv: string[] }
    expect(result.version).toBe('skills@1.7.1')
    expect(result.source).toEndWith('/client/skills')
    expect(result.target).toBe(process.cwd())
    expect(result.skills).toEqual(['crafty-example-workflow'])
    expect(result.agents).toEqual(['codex'])
    expect(result.argv).toContain('add')
    expect(result.argv).toContain('--copy')
    expect(result.argv).toContain('--yes')
  })
})
