import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  commands, configPathFromCli, extractGlobalOptions, parseCommandArgs, prepareCommand, run, runCommand, setCommands,
  setOutputSink, type RegisteredCommand,
} from '../src/index.ts'
import { captureCli } from './helpers/cli.ts'

let previousSink: ((text: string) => void) | null = null
let previousCommands: RegisteredCommand[] = []

beforeEach(() => {
  previousCommands = commands()
  previousSink = setOutputSink(null)
})

afterEach(() => {
  setCommands(previousCommands)
  setOutputSink(previousSink)
})

describe('single-value option duplicates', () => {
  const options = [{ name: 'mode', type: 'string' as const, short: 'm' }]

  test.each([
    ['long then short', ['--mode', 'first', '-m', 'second']],
    ['attached short values', ['-mfirst', '-msecond']],
    ['attached short then separate long', ['-mfirst', '--mode', 'second']],
    ['short cluster then short', ['-xmfirst', '-msecond']],
  ])('rejects duplicates across %s', (_label, argv) => {
    expect(() => parseCommandArgs(argv, [...options, { name: 'extra', type: 'boolean', short: 'x' }]))
      .toThrow('--mode may only be given once')
  })

  test('does not count option-looking values or standalone tail tokens as options', () => {
    expect(parseCommandArgs(['--mode=-looks-like-an-option'], options).values.mode).toBe('-looks-like-an-option')
    expect(parseCommandArgs(['--mode', 'first', '--', '--mode', 'second'], options)).toMatchObject({
      values: { mode: 'first' },
      tail: ['--mode', 'second'],
    })
  })
})

describe('config path invocation scopes', () => {
  test('extracts config before and after the root command, but stops at standalone --', async () => {
    const seen: Array<string | undefined> = []
    setCommands([prepareCommand('scope', { run() { seen.push(configPathFromCli()) } })])

    expect(await run(['--config', 'before.json', 'scope', '--verbose', '-c', 'after.json'])).toBe(0)
    expect(seen).toEqual(['after.json'])

    const stripped = extractGlobalOptions(['scope', '--config=between.json', '--', '--config', 'tail.json'])
    expect(stripped).toEqual(['scope', '--', '--config', 'tail.json'])
    expect(configPathFromCli()).toBe('between.json')
  })

  test('starts each top-level run without a config inherited from the previous run', async () => {
    const seen: Array<string | undefined> = []
    setCommands([prepareCommand('scope', { run() { seen.push(configPathFromCli()) } })])

    expect(await run(['--config', 'first.json', 'scope'])).toBe(0)
    expect(await run(['scope'])).toBe(0)
    expect(seen).toEqual(['first.json', undefined])
  })

  test('nested run and runCommand inherit config and restore child overrides after success or failure', async () => {
    const seen: Array<string | undefined> = []
    const directChild = prepareCommand('direct-child', {
      run() { seen.push(configPathFromCli()) },
    })
    const failingChild = prepareCommand('failing-child', {
      run() {
        seen.push(configPathFromCli())
        throw new Error('child failed')
      },
    })
    setCommands([
      prepareCommand('step', { run() { seen.push(configPathFromCli()) } }),
      prepareCommand('outer', {
        async run() {
          seen.push(configPathFromCli())
          await run(['step'])
          await run(['--config', 'step.json', 'step'])
          seen.push(configPathFromCli())
          await run(['--config', 'failed-step.json', 'missing'])
          seen.push(configPathFromCli())
          await runCommand(directChild, ['--config', 'direct.json'])
          seen.push(configPathFromCli())
          await runCommand(failingChild, ['--config', 'direct-error.json'])
          seen.push(configPathFromCli())
        },
      }),
    ])

    const result = await captureCli(() => run(['--config', 'outer.json', 'outer']))
    expect(result.code).toBe(0)
    expect(seen).toEqual([
      'outer.json', 'outer.json', 'step.json', 'outer.json', 'outer.json', 'direct.json', 'outer.json',
      'direct-error.json', 'outer.json',
    ])
  })

  test('direct runCommand starts with fresh config on each top-level call', async () => {
    const seen: Array<string | undefined> = []
    const direct = prepareCommand('direct', { run() { seen.push(configPathFromCli()) } })

    expect(await runCommand(direct, ['--config', 'first.json'])).toBe(0)
    expect(await runCommand(direct, [])).toBe(0)
    expect(seen).toEqual(['first.json', undefined])
  })
})
