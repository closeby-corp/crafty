import { describe, expect, test } from 'bun:test'
import { prepareCommand, type RegisteredCommand } from '../src/command.ts'
import { completeWords, type CompletionResult } from '../src/completion.ts'

function fixture(): { registry: RegisteredCommand[]; calls: string[] } {
  const calls: string[] = []
  const run = () => { calls.push('run') }
  const init = () => { calls.push('init') }
  const destroy = () => { calls.push('destroy') }
  const registry = [
    prepareCommand('project', {
      aliases: ['p'], init, destroy,
      options: [
        { name: 'mode', type: 'string', short: 'm', completion: ['slow', 'fast', 'fast', 'fast=exact', 'two words', '$(literal)'] },
        { name: 'opaque', type: 'string', short: 'o' },
        { name: 'verbose', type: 'boolean', short: 'v' },
        { name: 'quiet', type: 'boolean', short: 'q' },
        { name: 'directory', type: 'string', short: 'd', completion: 'directory' },
      ],
      commands: {
        ':id': { options: [{ name: 'dynamic', type: 'boolean' }], commands: { inspect: { run } } },
        list: { aliases: ['ls'], options: [{ name: 'list-only', type: 'boolean' }], run },
        remote: {
          aliases: ['r'], options: [{ name: 'remote-only', type: 'boolean' }],
          commands: {
            fetch: { aliases: ['f'], options: [{ name: 'depth', type: 'string', short: 'n', completion: ['all', 'one'] }], run },
          },
        },
      },
    }),
    prepareCommand('plain', { run }),
    prepareCommand('repeat', {
      repeatable: ['tag', 'raw'],
      options: [{ name: 'tag', type: 'string', completion: ['red', 'blue'] }],
      commands: { go: { run } },
    }),
  ]
  return { registry, calls }
}

function complete(registry: RegisteredCommand[], ...words: string[]) {
  return completeWords(registry, ['tool', ...words], words.length)
}

const empty = (prefix = ''): CompletionResult => ({ kind: 'values', prefix, replacementPrefix: '', candidates: [] })

describe('metadata completion', () => {
  test('root candidates are sorted, unique, alias-aware and contain no flags', async () => {
    const { registry } = fixture()
    expect((await complete(registry, ''))).toEqual({
      kind: 'values', prefix: '', replacementPrefix: '',
      candidates: ['help', 'p', 'plain', 'project', 'repeat'],
    })
    expect((await complete(registry, 'p')).candidates).toEqual(['p', 'plain', 'project'])
    expect((await complete(registry, '--f'))).toEqual(empty('--f'))
    expect((await complete(registry, '-c')).candidates).toEqual([])
    expect((await complete(registry, '-cpath'))).toEqual(empty('-cpath'))
    expect((await complete(registry, '-vh', ''))).toEqual(empty())
  })

  test('static children and aliases win over an earlier dynamic parameter', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'p', 'l')).candidates).toEqual(['list', 'ls'])
    expect((await complete(registry, 'p', 'ls', '')).candidates).toEqual([])
    expect((await complete(registry, 'p', 'some-id', '')).candidates).toEqual(['inspect'])
    expect((await complete(registry, 'p', '')).candidates).not.toContain(':id')
  })

  test('suggests routes but never flag names, including when a dash prefix is typed', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'project', '')).candidates).toEqual(['list', 'ls', 'r', 'remote'])
    expect((await complete(registry, 'p', 'r', '')).candidates).toEqual(['f', 'fetch'])
    expect((await complete(registry, 'p', 'r', 'f', '')).candidates).toEqual([])
    for (const prefix of ['-', '--', '--mo', '--mode', '-v']) {
      expect((await complete(registry, 'project', prefix)).candidates).toEqual([])
      expect((await complete(registry, 'p', 'r', 'f', prefix)).candidates).toEqual([])
    }
    expect((await complete(registry, 'p', 'r', 'f', '--mode', 'fa')).candidates).toEqual(['fast', 'fast=exact'])
  })

  test('help, --help and -h route through root aliases and nested commands', async () => {
    const { registry } = fixture()
    for (const help of ['help', '--help', '-h']) {
      expect((await complete(registry, help, 'p')).candidates).toEqual(['p', 'plain', 'project'])
      expect((await complete(registry, help, 'p', 'r', 'f', '--depth', 'a')).candidates).toEqual(['all'])
    }
    expect((await complete(registry, 'help', 'help', ''))).toEqual(empty())
  })

  test('consumes descendant option values before and between routes without treating them as routes', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'project', '--depth', 'list', 'r', '')).candidates).toContain('fetch')
    expect((await complete(registry, 'project', 'r', '-n', 'list', 'f', '--depth', 'a')).candidates).toEqual(['all'])
    expect((await complete(registry, 'project', '--depth', 'a'))).toEqual({
      kind: 'values', prefix: 'a', replacementPrefix: '', candidates: ['all'],
    })
    expect((await complete(registry, 'project', '--depth=all', 'r', 'f', '--depth', 'o')).candidates).toEqual(['one'])
  })

  test('completes separate and attached enum values, retaining equals within the value', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'project', '--mode', 'fa'))).toEqual({
      kind: 'values', prefix: 'fa', replacementPrefix: '', candidates: ['fast', 'fast=exact'],
    })
    expect((await complete(registry, 'project', '--mode=fast='))).toEqual({
      kind: 'values', prefix: 'fast=', replacementPrefix: '--mode=', candidates: ['fast=exact'],
    })
    expect((await complete(registry, 'project', '-m', 's')).candidates).toEqual(['slow'])
    expect((await complete(registry, 'project', '-mfa'))).toEqual({
      kind: 'values', prefix: 'fa', replacementPrefix: '-m', candidates: ['fast', 'fast=exact'],
    })
    expect((await complete(registry, 'project', '-m=fa'))).toEqual({
      kind: 'values', prefix: '=fa', replacementPrefix: '-m', candidates: [],
    })
    expect((await complete(registry, 'project', '--mode', '')).candidates).toEqual(['$(literal)', 'fast', 'fast=exact', 'slow', 'two words'])
    expect((await complete(registry, 'project', '--mode')).candidates).toEqual([])
  })

  test('boolean short clusters consume no route words and a string ends its cluster', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'project', '-vq', 'r', 'f', '--depth', 'a')).candidates).toEqual(['all'])
    expect((await complete(registry, 'project', '-vqm', 'list', 'r', '')).candidates).toContain('fetch')
    expect((await complete(registry, 'project', '-vqmfa'))).toEqual({
      kind: 'values', prefix: 'fa', replacementPrefix: '-vqm', candidates: ['fast', 'fast=exact'],
    })
    expect((await complete(registry, 'project', '-vqmfast', 'r', '')).candidates).toContain('fetch')
    expect((await complete(registry, 'project', '--verbose=true', ''))).toEqual(empty())
    expect((await complete(registry, 'project', '-vx', ''))).toEqual(empty())
  })

  test('does not infer values for opaque string options or suggest routes in their place', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'project', '--opaque', 'l'))).toEqual(empty('l'))
    expect((await complete(registry, 'project', '--opaque=l'))).toEqual({ ...empty('l'), replacementPrefix: '--opaque=' })
    expect((await complete(registry, 'project', '-ol'))).toEqual({ ...empty('l'), replacementPrefix: '-o' })
    expect((await complete(registry, 'project', '--opaque', 'list', 'r', '')).candidates).toContain('fetch')
    expect((await complete(registry, 'project', '--mode', '--ver'))).toEqual(empty('--ver'))
  })

  test('uses explicit filesystem modes without scanning or synthesizing path candidates', async () => {
    const { registry } = fixture()
    expect((await complete(registry, '--config', 'my path/'))).toEqual({ kind: 'file', prefix: 'my path/', replacementPrefix: '', candidates: [] })
    expect((await complete(registry, '--config=my path/'))).toEqual({ kind: 'file', prefix: 'my path/', replacementPrefix: '--config=', candidates: [] })
    expect((await complete(registry, 'project', '-cmy path/'))).toEqual({ kind: 'file', prefix: 'my path/', replacementPrefix: '-c', candidates: [] })
    expect((await complete(registry, 'project', '-dtmp/'))).toEqual({ kind: 'directory', prefix: 'tmp/', replacementPrefix: '-d', candidates: [] })
    expect((await complete(registry, 'project', '--directory', 'tmp/'))).toEqual({ kind: 'directory', prefix: 'tmp/', replacementPrefix: '', candidates: [] })
  })

  test('extracts config before root and before command value parsing', async () => {
    const { registry } = fixture()
    for (const prefix of [['--config', 'a.json'], ['--config=a.json'], ['-c', 'a.json']]) {
      expect((await complete(registry, ...prefix, 'p', 'r', 'f', '--depth', 'a')).candidates).toEqual(['all'])
    }
    expect((await complete(registry, 'project', '--mode', '--config', 'a.json', 'list', 'r', '')).candidates).toContain('fetch')
    expect((await complete(registry, 'project', '--mode', '--config=a.json', 'fa')).candidates).toEqual(['fast', 'fast=exact'])
    expect((await complete(registry, '-cpath', 'p', ''))).toEqual(empty())
    expect((await complete(registry, '--config', '--mode', ''))).toEqual(empty())
  })

  test('repeatable options consume flag-looking values before route parsing', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'repeat', '--tag', '--unknown', 'g')).candidates).toEqual(['go'])
    expect((await complete(registry, 'repeat', '--tag=blue', '--tag', 'red', 'g')).candidates).toEqual(['go'])
    expect((await complete(registry, 'repeat', '--tag', 'b')).candidates).toEqual(['blue'])
    expect((await complete(registry, 'repeat', '--tag=b'))).toEqual({ kind: 'values', prefix: 'b', replacementPrefix: '--tag=', candidates: ['blue'] })
    expect((await complete(registry, 'repeat', '--raw', 'g'))).toEqual(empty('g'))
    expect((await complete(registry, 'repeat', '--raw', 'ignored', 'g')).candidates).toEqual(['go'])
  })

  test('standalone -- stops all metadata completion, including pending values', async () => {
    const { registry } = fixture()
    for (const head of [[], ['project'], ['project', '--mode'], ['repeat', '--raw']]) {
      expect((await complete(registry, ...head, '--', '--config=x'))).toEqual(empty('--config=x'))
    }
    expect((await complete(registry, 'project', '--mode=--', 'r', 'f', '--depth', 'a')).candidates).toEqual(['all'])
  })

  test('unknown roots and routes stop traversal, while handler positionals do not become routes', async () => {
    const { registry } = fixture()
    expect((await complete(registry, 'missing', ''))).toEqual(empty())
    expect((await complete(registry, 'project', 'r', 'missing', ''))).toEqual(empty())
    expect((await complete(registry, 'plain', 'arbitrary', '--format', 'j')).candidates).toEqual(['json'])
    expect((await complete(registry, 'project', 'r', 'missing', '--config=x'))).toEqual(empty('--config=x'))
  })

  test('ignores words after the cursor and supports an absent empty current word', async () => {
    const { registry } = fixture()
    expect((await completeWords(registry, ['tool', 'project', 'r', 'f', '--depth', 'all'], 2)).candidates).toEqual(['r', 'remote'])
    expect((await completeWords(registry, ['tool', 'project', 'r'], 3)).candidates).toContain('fetch')
    expect((await completeWords(registry, ['tool'], 0))).toEqual(empty('tool'))
    expect((await completeWords(registry, ['tool'], 2))).toEqual(empty())
  })

  test('never calls hooks or target handlers, and observes the supplied registry each time', async () => {
    const { registry, calls } = fixture()
    await complete(registry, 'project', 'r', 'f', '')
    await complete(registry, 'project', 'some-id', 'inspect', '')
    await complete(registry, 'help', 'project', 'list', '')
    expect(calls).toEqual([])
    expect((await complete([], 'p')).candidates).toEqual([])
    expect((await complete([registry[0]!], 'p')).candidates).toEqual(['p', 'project'])
  })
})
