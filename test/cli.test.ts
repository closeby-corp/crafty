import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCommand, runCommand, type CommandModule, type RegisteredCommand } from '../src/command.ts'
import { emitResult, write, type Ctx } from '../src/output.ts'
import { commands, resolveCommand, run, setCommands, setOutputSink } from '../src/cli.ts'
import { loadCommands } from '../src/loader.ts'
import { OpsError } from '../src/errors.ts'
import { envelope, runCaptured } from './helpers/cli.ts'

const fixtures: string[] = []
const globalKeys: string[] = []
const registrySnapshots: RegisteredCommand[][] = []
let previousSink: ((text: string) => void) | null = null
const makeTemp = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'crafty-cli-test-'))
  fixtures.push(path)
  return path
}
const command = (definition: CommandModule) => prepareCommand(definition.name ?? 'fixture', definition)

beforeEach(() => {
  registrySnapshots.push(commands())
  previousSink = setOutputSink(null)
})
afterEach(() => {
  const snapshot = registrySnapshots.pop()
  if (snapshot) setCommands(snapshot)
  for (const key of globalKeys.splice(0)) Reflect.deleteProperty(globalThis, key)
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
  setOutputSink(previousSink)
})


describe('recursive command routing and lifecycle', () => {
  test('awaits the selected path in order, shares context and starts each invocation fresh', async () => {
    const events: string[] = []
    const contexts: unknown[] = []
    const held = new Set<symbol>()
    const acquire = (ctx: Ctx, name: string): void => {
      const resource = Symbol(name)
      held.add(resource)
      ctx.state[name] = resource
    }
    const release = async (ctx: Ctx, name: string): Promise<void> => {
      await Promise.resolve()
      expect(held.delete(ctx.state[name] as symbol)).toBe(true)
      delete ctx.state[name]
      contexts.push(ctx)
      events.push(`${name}:destroy`)
    }
    const fixture = command({
      name: 'fixture', source: 'root-source',
      async init(ctx) {
        events.push('root:init')
        contexts.push(ctx)
        expect(ctx.params.database).toBe(ctx.path.split(' ')[3])
        expect(ctx.state).toEqual({})
        expect(held.size).toBe(0)
        await Promise.resolve()
        acquire(ctx, 'root')
      },
      destroy(ctx) { return release(ctx, 'root') },
      commands: {
        group: {
          source: 'group-source',
          async init(ctx) {
            events.push('group:init')
            contexts.push(ctx)
            expect(typeof ctx.state.root).toBe('symbol')
            await Promise.resolve()
            acquire(ctx, 'group')
          },
          destroy(ctx) { return release(ctx, 'group') },
          commands: {
            ':database': {
              async init(ctx) {
                events.push('database:init')
                contexts.push(ctx)
                expect(typeof ctx.state.group).toBe('symbol')
                await Promise.resolve()
                acquire(ctx, 'database')
              },
              destroy(ctx) { return release(ctx, 'database') },
              commands: {
                query: {
                  source: 'query-source',
                  async init(ctx) {
                    events.push('leaf:init')
                    contexts.push(ctx)
                    expect(typeof ctx.state.database).toBe('symbol')
                    await Promise.resolve()
                    acquire(ctx, 'leaf')
                  },
                  async run(ctx) {
                    events.push('run')
                    contexts.push(ctx)
                    expect(typeof ctx.state.leaf).toBe('symbol')
                    await Promise.resolve()
                    emitResult(ctx, { source: ctx.source, params: ctx.params, args: ctx.positionals, path: ctx.path })
                  },
                  destroy(ctx) { return release(ctx, 'leaf') },
                },
                sibling: { init() { events.push('sibling:init') }, run() { events.push('sibling:run') }, destroy() { events.push('sibling:destroy') } },
              },
            },
          },
        },
      },
    })
    const first = await runCaptured(fixture.definition, ['group', 'sd', 'query', 'events', '--json'])
    expect(first.code).toBe(0)
    expect(envelope(first).data).toEqual({ source: 'query-source', params: { database: 'sd' }, args: ['events'], path: 'crafty fixture group sd query' })
    expect(events).toEqual(['root:init', 'group:init', 'database:init', 'leaf:init', 'run', 'leaf:destroy', 'database:destroy', 'group:destroy', 'root:destroy'])
    expect(new Set(contexts).size).toBe(1)
    expect(held.size).toBe(0)
    const firstContext = contexts[0] as Ctx
    events.length = 0
    contexts.length = 0
    const second = await runCaptured(fixture.definition, ['group', 'prod', 'query', 'logs', '--json'])
    expect(second.code).toBe(0)
    expect(envelope(second).data).toEqual({ source: 'query-source', params: { database: 'prod' }, args: ['logs'], path: 'crafty fixture group prod query' })
    expect(new Set(contexts).size).toBe(1)
    expect((contexts[0] as Ctx).state).not.toBe(firstContext.state)
    expect((contexts[0] as Ctx).params).not.toBe(firstContext.params)
    expect(contexts[0]).not.toBe(firstContext)
    expect(firstContext.params).toEqual({ database: 'sd' })
    expect(events).not.toContain('sibling:init')
    expect(events).not.toContain('sibling:run')
    expect(events).not.toContain('sibling:destroy')
    expect(held.size).toBe(0)
  })

  test('does not run inactive hooks; static children and aliases win over parameters', async () => {
    const seen: string[] = []
    const fixture = command({ name: 'routes', commands: {
      ':item': { commands: { query: (ctx) => { seen.push(`dynamic:${ctx.params.item}`) } } },
      list: { aliases: ['ls'], run: () => { seen.push('list') } },
      all: { run: () => { seen.push('all') } },
    } })
    expect(await runCommand(fixture, ['list'])).toBe(0)
    expect(await runCommand(fixture, ['ls'])).toBe(0)
    expect(await runCommand(fixture, ['all'])).toBe(0)
    expect(await runCommand(fixture, ['x', 'query'])).toBe(0)
    expect(seen).toEqual(['list', 'list', 'all', 'dynamic:x'])
  })

  test('resolves canonical path and innermost source, with only leaf arguments', async () => {
    let result: unknown
    const fixture = command({ name: 'root', source: 'root-source', commands: {
      canonical: { aliases: ['short'], source: 'inner-source', commands: {
        ':id': { run(ctx) { result = { path: ctx.path, source: ctx.source, params: ctx.params, args: ctx.positionals } } },
      } },
    } })
    expect(await runCommand(fixture, ['short', 'abc', 'tail'])).toBe(0)
    expect(result).toEqual({ path: 'crafty root canonical abc', source: 'inner-source', params: { id: 'abc' }, args: ['tail'] })
  })

  test('tears down partial initialization, preserving the original auth failure and exit code', async () => {
    const events: string[] = []
    const fixture = command({ name: 'initfail', init() { events.push('root:init') }, destroy() { events.push('root:destroy') }, commands: {
      group: { init() { events.push('group:init') }, destroy() { events.push('group:destroy') }, commands: {
        branch: { init() { events.push('branch:init'); throw new OpsError('denied', 'auth') }, destroy() { events.push('branch:destroy') }, commands: {
          leaf: { init() { events.push('leaf:init') }, destroy() { events.push('leaf:destroy') }, run() { events.push('run') } },
        } },
      } },
    } })
    const result = await runCaptured(fixture.definition, ['group', 'branch', 'leaf', '--json'])
    expect(result.code).toBe(3)
    expect(envelope(result)).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(events).toEqual(['root:init', 'group:init', 'branch:init', 'branch:destroy', 'group:destroy', 'root:destroy'])
  })

  test('continues teardown and gives primary errors and explicit nonzero status precedence', async () => {
    const make = (run: NonNullable<CommandModule['run']>) => command({ name: 'cleanup', destroy() { throw new Error('root cleanup') }, commands: {
      leaf: { destroy() { throw new Error('leaf cleanup') }, run },
    } })
    const primary = await runCaptured(make(() => { throw new OpsError('denied', 'auth') }).definition, ['leaf', '--json'])
    expect(primary.code).toBe(3)
    expect(envelope(primary)).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(primary.stderr).toContain('leaf cleanup')
    expect(primary.stderr).toContain('root cleanup')
    const status = await runCaptured(make((ctx) => { emitResult(ctx, { status: true }, { truncated: false }); return 7 }).definition, ['leaf', '--json'])
    expect(status.code).toBe(7)
    expect(status.stderr).toContain('leaf cleanup')
    expect(status.stderr).toContain('root cleanup')
    expect(envelope(status)).toMatchObject({ ok: true, data: { status: true } })
    const cleanup = await runCaptured(make(() => { write('unexpected') }).definition, ['leaf', '--json'])
    expect(cleanup.code).toBe(1)
    expect(cleanup.stderr).toContain('root cleanup')
    expect(envelope(cleanup)).toMatchObject({ ok: false, error: { kind: 'internal', message: 'leaf cleanup' } })
    expect(cleanup.stdout).not.toContain('unexpected')
  })

  test('promotes cleanup-only auth errors to runtime failures and redacts additional failures', async () => {
    const cleanup = await runCaptured({
      name: 'cleanup-auth',
      run(ctx) { emitResult(ctx, { uncommitted: true }) },
      destroy() { throw new OpsError('cleanup denied', 'auth') },
    }, ['--json'])
    expect(cleanup.code).toBe(1)
    expect(envelope(cleanup)).toMatchObject({ ok: false, error: { kind: 'internal' } })
    expect(cleanup.stdout).not.toContain('uncommitted')

    const primary = await runCaptured({
      name: 'primary-auth',
      run() { throw new OpsError('execution denied', 'auth') },
      destroy() { throw new Error('Bearer cleanup-token') },
    }, ['--json'])
    expect(primary.code).toBe(3)
    expect(envelope(primary)).toMatchObject({ ok: false, error: { kind: 'auth' } })
    expect(primary.stderr).toContain('[redacted]')
    expect(primary.stderr).not.toContain('cleanup-token')
  })

  test('rejects invalid handler status without committing buffered JSON success', async () => {
    const fixture = command({ name: 'invalid', run(ctx) { emitResult(ctx, { success: true }, { truncated: false }); return 256 } })
    const result = await runCaptured(fixture.definition, ['--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false })
    expect(result.stdout).not.toContain('"success": true')
  })

  test('help, missing and unknown routes do not run lifecycle hooks', async () => {
    let hooks = 0
    const fixture = command({ name: 'quiet', init() { hooks++ }, commands: { group: { init() { hooks++ }, commands: { leaf: { init() { hooks++ }, run() {} } } } } })
    expect((await runCaptured(fixture.definition, ['--help'])).code).toBe(0)
    expect((await runCaptured(fixture.definition, ['group', '--help'])).code).toBe(0)
    expect((await runCaptured(fixture.definition, ['group'])).code).toBe(2)
    expect((await runCaptured(fixture.definition, ['group', 'unknown', '--json'])).code).toBe(2)
    setCommands([fixture])
    const output: string[] = []
    const previous = setOutputSink((text) => output.push(text))
    try {
      expect(await run(['help', 'quiet', 'group'])).toBe(0)
    } finally {
      setOutputSink(previous)
    }
    expect(hooks).toBe(0)
    expect(output.join('')).toContain('leaf')
  })

  test('uses declared usage when nonempty, otherwise generates parameter and inherited-option help', async () => {
    const fixture: CommandModule = {
      name: 'help-options',
      usage: [],
      options: [{ name: 'root-option', type: 'string' }],
      commands: {
        ':subject': {
          commands: {
            leaf: { options: [{ name: 'leaf-option', type: 'string' }], run() {} },
          },
        },
        custom: { usage: ['operator-defined usage'], run() {} },
        sibling: { options: [{ name: 'unselected-option', type: 'string' }], run() {} },
      },
    }
    const root = await runCaptured(fixture, ['--help'])
    expect(root.code).toBe(0)
    expect(root.stdout).toContain('<subject>')
    const leaf = await runCaptured(fixture, ['sd', 'leaf', '--help'])
    expect(leaf.code).toBe(0)
    expect(leaf.stdout).toContain('--root-option')
    expect(leaf.stdout).toContain('--leaf-option')
    expect(leaf.stdout).not.toContain('--unselected-option')
    expect((await runCaptured(fixture, ['custom', '--help'])).stdout).toBe('operator-defined usage\n')
  })

  test('captures prototype-spelled parameter names as ordinary strings', async () => {
    const result = await runCaptured({
      name: 'parameter',
      commands: {
        ':__proto__': { run(ctx) { emitResult(ctx, { captured: ctx.params['__proto__'] }) } },
      },
    }, ['value', '--json'])
    expect(result.code).toBe(0)
    expect(envelope(result)).toMatchObject({ ok: true, data: { captured: 'value' } })
  })

  test('preserves repeatables, extracts route options and keeps standalone -- tail raw', async () => {
    let received: unknown
    const fixture = command({ name: 'args', repeatable: ['param'], options: [{ name: 'limit', type: 'string' }], commands: {
      group: { commands: { leaf(ctx) { received = { values: ctx.values, repeat: ctx.repeat, positionals: ctx.positionals, tail: ctx.tail } } } },
    } })
    expect(await runCommand(fixture, ['group', '--limit', '5', '--param', 'a=1', 'leaf', '--param=b=2', '--', '--config', 'other.yml', '--json'])).toBe(0)
    expect(received).toMatchObject({ values: { limit: '5' }, repeat: { param: ['a=1', 'b=2'] }, positionals: [], tail: ['--config', 'other.yml', '--json'] })
  })

  test('does not infer preparse JSON mode from tail tokens', async () => {
    const result = await runCaptured({ name: 'preparse', run() {} }, ['--unknown', '--', '--json', '--format=json'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
  })

  test('restores nested JSON captures and discards a child success on failure', async () => {
    const inner = command({
      name: 'inner',
      run(ctx) {
        emitResult(ctx, { uncommitted: true })
        throw new OpsError('inner denied', 'auth')
      },
    })
    const outer = command({
      name: 'outer',
      async run(ctx) {
        let captured = ''
        const previous = setOutputSink((text) => { captured += text })
        let code: number
        try {
          code = await runCommand(inner, ['--json'])
        } finally {
          setOutputSink(previous)
        }
        emitResult(ctx, { code, child: JSON.parse(captured) })
      },
    })
    const result = await runCaptured(outer.definition, ['--json'])
    expect(result.code).toBe(0)
    expect(envelope(result)).toMatchObject({
      ok: true, source: 'outer',
      data: { code: 3, child: { ok: false, source: 'inner', error: { kind: 'auth' } } },
    })
    expect(result.stdout).not.toContain('uncommitted')
  })
})

describe('command preparation validation', () => {
  test('rejects object cycles but executes shared acyclic subtrees', async () => {
    const visited: string[] = []
    const shared = { run(ctx: Ctx) { visited.push(ctx.path) } }
    const cyclic: CommandModule = { commands: {} }
    cyclic.commands!['again'] = cyclic
    expect(() => prepareCommand('cycle', cyclic)).toThrow()
    const valid = command({ name: 'shared', commands: { one: shared, two: shared } })
    expect(await runCommand(valid, ['one'])).toBe(0)
    expect(await runCommand(valid, ['two'])).toBe(0)
    expect(visited).toEqual(['crafty shared one', 'crafty shared two'])
  })

  test('rejects sibling collisions, repeated parameters, invalid hooks and conflicting option declarations', () => {
    expect(() => prepareCommand('bad', { commands: { one: { aliases: ['two'], run() {} }, two: { run() {} } } })).toThrow()
    expect(() => prepareCommand('bad', { commands: { ':id': { commands: { ':id': { run() {} } } } } })).toThrow()
    expect(() => prepareCommand('bad', { init: 1 as never, run() {} })).toThrow()
    expect(() => prepareCommand('bad', { options: [{ name: 'mode', type: 'string' }], commands: { leaf: { options: [{ name: 'mode', type: 'boolean' }], run() {} } } })).toThrow()
    expect(() => prepareCommand('bad', { options: [{ name: 'mode', type: 'string', short: 'm' }], commands: { leaf: { options: [{ name: 'limit', type: 'string', short: 'm' }], run() {} } } })).toThrow()
    expect(() => prepareCommand('bad', { commands: { 'two words': { run() {} } } })).toThrow()
  })

  test('rejects ambiguous parameter routes, parameter aliases, and reserved roots', () => {
    expect(() => prepareCommand('help', { run() {} })).toThrow()
    expect(() => prepareCommand('bad', { aliases: ['help'], run() {} })).toThrow()
    expect(() => prepareCommand('bad', { commands: { ':one': { run() {} }, ':two': { run() {} } } })).toThrow()
    expect(() => prepareCommand('bad', { commands: { ':id': { aliases: ['one'], run() {} } } })).toThrow()
    expect(() => prepareCommand('bad', { commands: { ':1id': { run() {} } } })).toThrow()
    expect(() => prepareCommand('bad', { run() {}, commands: { leaf() {} } })).toThrow()
    expect(() => prepareCommand('bad', { commands: {} })).toThrow()
  })
})

describe('file-discovered command loading', () => {
  test('loads sorted direct TS modules, excludes declarations and nested files, and honors name overrides', async () => {
    const directory = makeTemp()
    const orderKey = `__crafty_import_order_${Date.now()}_${Math.random()}`
    const lifecycleKey = `__crafty_lifecycle_${Date.now()}_${Math.random()}`
    globalKeys.push(orderKey, lifecycleKey)
    Reflect.set(globalThis, orderKey, [])
    Reflect.set(globalThis, lifecycleKey, [])
    const source = (name: string | undefined, marker: string) =>
      `const order = Reflect.get(globalThis, ${JSON.stringify(orderKey)}) as string[]; order.push(${JSON.stringify(marker)}); export default { ${name ? `name: ${JSON.stringify(name)},` : ''} init() { const lifecycle = Reflect.get(globalThis, ${JSON.stringify(lifecycleKey)}) as string[]; lifecycle.push(${JSON.stringify(marker)}) }, run() {} }`
    writeFileSync(join(directory, 'zeta.ts'), source('override', 'zeta'))
    writeFileSync(join(directory, 'alpha.ts'), source('alpha', 'alpha'))
    writeFileSync(join(directory, 'gamma.ts'), source(undefined, 'gamma'))
    writeFileSync(join(directory, 'ignored.d.ts'), 'invalid syntax')
    mkdirSync(join(directory, 'nested'))
    writeFileSync(join(directory, 'nested', 'hidden.ts'), source('hidden', 'hidden'))
    symlinkSync(join(directory, 'alpha.ts'), join(directory, 'linked.ts'))
    await loadCommands(directory)
    expect(Reflect.get(globalThis, orderKey)).toEqual(['alpha', 'gamma', 'zeta'])
    expect(Reflect.get(globalThis, lifecycleKey)).toEqual([])
    expect(commands().map((item) => item.name)).toContain('alpha')
    expect(resolveCommand('override')).toBeDefined()
    expect(resolveCommand('gamma')).toBeDefined()
    expect(resolveCommand('gamma')!.name).toBe('gamma')
    expect(await runCommand(resolveCommand('gamma')!, [])).toBe(0)
    expect(Reflect.get(globalThis, lifecycleKey)).toEqual(['gamma'])
    expect(resolveCommand('linked')).toBeUndefined()
  })

  test('supports empty directories and rejects missing directories and invalid default exports', async () => {
    const empty = makeTemp()
    await loadCommands(empty)
    expect(commands()).toEqual([])
    let help = ''
    const previous = setOutputSink((text) => { help += text })
    try {
      expect(await run([])).toBe(0)
    } finally {
      setOutputSink(previous)
    }
    expect(help).toContain('crafty <command>')
    await expect(loadCommands(join(empty, 'missing'))).rejects.toThrow()
    const invalid = makeTemp()
    writeFileSync(join(invalid, 'broken.ts'), 'export default 42')
    await expect(loadCommands(invalid)).rejects.toThrow()
  })

  test('rejects root alias collisions and leaves installed registry unchanged after failed load', async () => {
    const before = commands()
    const duplicate = makeTemp()
    writeFileSync(join(duplicate, 'one.ts'), 'export default { name: "one", aliases: ["same"], run() {} }')
    writeFileSync(join(duplicate, 'two.ts'), 'export default { name: "two", aliases: ["same"], run() {} }')
    await expect(loadCommands(duplicate)).rejects.toThrow()
    expect(commands()).toEqual(before)
    const importFailure = makeTemp()
    writeFileSync(join(importFailure, 'bad.ts'), 'throw new Error("module failure")')
    await expect(loadCommands(importFailure)).rejects.toThrow()
    expect(commands()).toEqual(before)
  })
})
