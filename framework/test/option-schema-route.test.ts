import { afterEach, describe, expect, test } from 'bun:test'
import { completeWords } from '../src/completion.ts'
import { runCaptured } from './helpers/cli.ts'
import { emitDryRun, manifest, prepareCommand, setOutputSink, type CommandModule, type Ctx } from '../src/index.ts'

let previousSink: ((text: string) => void) | null = null
afterEach(() => { setOutputSink(previousSink) })

describe('option schema and selected route validation', () => {
  test('parses repeatable long, attached short, and short cluster forms before and after routes', async () => {
    let observed: unknown
    const command = prepareCommand('repeat', {
      name: 'repeat',
      options: [{ name: 'tag', type: 'string', short: 't', repeatable: true }],
      commands: {
        group: { commands: { leaf: { run(ctx) {
          observed = { repeat: ctx.repeat, positionals: ctx.positionals, tail: ctx.tail }
        } } } },
      },
    })
    const result = await runCaptured(command.definition, [
      '-vtone', '--tag', '-flag-looking', 'group', 'leaf', '--tag=three', '--', '--tag', 'tail',
    ])
    expect(result.code).toBe(0)
    expect(observed).toEqual({ repeat: { tag: ['one', '-flag-looking', 'three'] }, positionals: [], tail: ['--tag', 'tail'] })
  })

  test('keeps legacy repeatable names without OptionSpec', async () => {
    let repeat: Ctx['repeat'] | undefined
    const command = prepareCommand('legacy', {
      name: 'legacy',
      repeatable: ['param'],
      run(ctx) { repeat = ctx.repeat },
    })
    expect((await runCaptured(command.definition, ['--param', 'first', '--param=second'])).code).toBe(0)
    expect(repeat).toEqual({ param: ['first', 'second'] })
  })

  test('stores prototype-spelled legacy repeatable names as ordinary keys', async () => {
    let repeat: Ctx['repeat'] | undefined
    const command = prepareCommand('prototype', {
      name: 'prototype', repeatable: ['constructor', '__proto__'], run(ctx) { repeat = ctx.repeat },
    })
    expect((await runCaptured(command.definition, ['--constructor', 'one', '--constructor=two', '--__proto__', 'three'])).code).toBe(0)
    expect(Object.hasOwn(repeat!, 'constructor')).toBe(true)
    expect(Object.hasOwn(repeat!, '__proto__')).toBe(true)
    expect(repeat?.['constructor']).toEqual(['one', 'two'])
    expect(repeat?.['__proto__']).toEqual(['three'])
  })

  test('does not mistake text attached to another string option for a repeatable short alias', async () => {
    let values: Ctx['values'] | undefined
    let repeat: Ctx['repeat'] | undefined
    const command = prepareCommand('shorts', {
      name: 'shorts',
      options: [
        { name: 'mode', type: 'string', short: 'm' },
        { name: 'tag', type: 'string', short: 't' },
      ],
      repeatable: ['tag'],
      run(ctx) { values = ctx.values; repeat = ctx.repeat },
    })
    expect((await runCaptured(command.definition, ['-mcat'])).code).toBe(0)
    expect(values?.mode).toBe('cat')
    expect(repeat).toEqual({})
    expect((await runCaptured(command.definition, ['-tfirst'])).code).toBe(0)
    expect(repeat).toEqual({ tag: ['first'] })
  })

  test('accepts selected descendant options before the route and rejects sibling options before hooks', async () => {
    const events: string[] = []
    const command: CommandModule = {
      name: 'routes',
      commands: {
        alpha: { options: [{ name: 'alpha-only', type: 'boolean' }], run() { events.push('alpha') } },
        beta: {
          init() { events.push('beta:init') },
          options: [{ name: 'beta-only', type: 'boolean' }],
          run(ctx) { events.push(`beta:${String(ctx.values['alpha-only'])}:${String(ctx.values['beta-only'])}`) },
        },
      },
    }
    expect((await runCaptured(command, ['--beta-only', 'beta'])).code).toBe(0)
    expect(events).toEqual(['beta:init', 'beta:undefined:true'])
    events.length = 0
    const invalid = await runCaptured(command, ['--alpha-only', 'beta', '--json'])
    expect(invalid.code).toBe(2)
    expect(invalid.stdout).toContain('"kind": "usage"')
    expect(events).toEqual([])
  })

  test('uses selected-route repeatability when siblings declare the same option differently', async () => {
    for (const reverse of [false, true]) {
      let observed: unknown
      const repeat = { options: [{ name: 'tag', type: 'string' as const, repeatable: true }], run() {} }
      const single = { options: [{ name: 'tag', type: 'string' as const }], run(ctx: Ctx) {
        observed = { values: ctx.values, repeat: ctx.repeat }
      } }
      const commands = reverse ? { b: single, a: repeat } : { a: repeat, b: single }
      const command: CommandModule = { name: 'routes', commands }
      const one = await runCaptured(command, ['b', '--tag', 'one'])
      expect(one.code).toBe(0)
      expect(observed).toEqual({ values: { tag: 'one' }, repeat: {} })

      const duplicate = await runCaptured(command, ['b', '--tag', 'one', '--tag', 'two'])
      expect(duplicate.code).toBe(2)

      const ambiguous = await runCaptured(command, ['b', '--tag', '--literal'])
      expect(ambiguous.code).toBe(2)
      const attached = await runCaptured(command, ['b', '--tag=--literal'])
      expect(attached.code).toBe(0)
      expect(observed).toEqual({ values: { tag: '--literal' }, repeat: {} })
    }
  })

  test('does not inherit a sibling legacy repeatable declaration', async () => {
    let observed: unknown
    const command: CommandModule = {
      name: 'routes',
      commands: {
        a: { repeatable: ['tag'], run() {} },
        b: { options: [{ name: 'tag', type: 'string' }], run(ctx) {
          observed = { values: ctx.values, repeat: ctx.repeat }
        } },
      },
    }
    expect((await runCaptured(command, ['b', '--tag', 'one'])).code).toBe(0)
    expect(observed).toEqual({ values: { tag: 'one' }, repeat: {} })
  })

  test('registers sensitive values before parse diagnostics and exposes selected spellings for previews', async () => {
    const secret = 'private-value-for-redaction'
    const command = prepareCommand('secure', {
      name: 'secure',
      options: [{ name: 'private-value', type: 'string', short: 'p', sensitive: true }],
      run(ctx) {
        expect(ctx.values['private-value']).toBe(secret)
        emitDryRun(ctx, 'preview', {
          argv: ['helper', '-p', secret],
          sensitiveArgvOptions: ctx.sensitiveArgvOptions,
        })
      },
    })
    const preview = await runCaptured(command.definition, ['-p', secret, '--json'])
    expect(preview.code).toBe(0)
    expect(preview.stdout).toContain('[redacted]')
    expect(preview.stdout).not.toContain(secret)

    const diagnostic = await runCaptured(command.definition, ['--private-value', secret, `--bad=${secret}`, '--json'])
    expect(diagnostic.code).toBe(2)
    expect(diagnostic.stdout).not.toContain(secret)
  })

  test('redacts sensitive short aliases inside subprocess clusters', () => {
    expect(manifest({ argv: ['helper', '--unrelated', 'value', '-vpVERYSECRET'], sensitiveArgvOptions: ['-p'] }))
      .toEqual({ command: 'helper --unrelated value -vp[redacted]' })
    const planned = { argv: ['helper', '-sabcpxyz'], sensitiveArgvOptions: ['-p', '-s'] }
    expect(manifest(planned)).toEqual({ command: 'helper -s[redacted]' })
    expect(planned.argv[1]).toBe('-sabcpxyz')
  })

  test('rejects repeatable and sensitive metadata on boolean options', () => {
    expect(() => prepareCommand('bad-repeat', { options: [{ name: 'switch', type: 'boolean', repeatable: true }], run() {} })).toThrow()
    expect(() => prepareCommand('bad-sensitive', { options: [{ name: 'switch', type: 'boolean', sensitive: true }], run() {} })).toThrow()
  })

  test('does not apply single-value checks to boolean flags', async () => {
    const command = prepareCommand('bools', {
      name: 'bools', options: [{ name: 'verbose', type: 'boolean' }], run() {},
    })
    expect((await runCaptured(command.definition, ['--verbose', '--verbose'])).code).toBe(0)
  })

  test('completion recognizes repeatable short aliases and rejects sibling-only options', async () => {
    const command = prepareCommand('complete', {
      options: [
        { name: 'tag', type: 'string', short: 't', repeatable: true, completion: ['one', 'two'] },
        { name: 'verbose', type: 'boolean', short: 'v' },
      ],
      commands: {
        local: { options: [{ name: 'private', type: 'string', completion: ['secret'] }], run() {} },
        other: { run() {} },
      },
    })
    expect(await completeWords([command], ['tool', 'complete', '-t', 'o'], 3)).toMatchObject({
      kind: 'values', prefix: 'o', replacementPrefix: '', candidates: ['one'],
    })
    expect((await completeWords([command], ['tool', 'complete', '-t', '--literal', 'l'], 4)).candidates).toEqual(['local'])
    expect((await completeWords([command], ['tool', 'complete', '-vt', '--literal', 'l'], 4)).candidates).toEqual(['local'])
    expect((await completeWords([command], ['tool', 'complete', '--private', 'value', 'other', ''], 5)).candidates).toEqual([])
  })

  test('completion rejects sibling boolean short clusters before calling a selected provider', async () => {
    let calls = 0
    const command = prepareCommand('routes', {
      commands: {
        a: { options: [{ name: 'a-only', type: 'boolean', short: 'a' }], run() {} },
        b: {
          options: [{ name: 'pick', type: 'string', completion() { calls += 1; return ['one'] } }],
          run() {},
        },
      },
    })
    expect((await completeWords([command], ['tool', 'routes', '-a', 'b', '--pick', 'o'], 5)).candidates).toEqual([])
    expect(calls).toBe(0)
  })
})
