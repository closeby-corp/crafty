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
  test('root candidates are sorted, unique, alias-aware and limited to root-supported flags', () => {
    const { registry } = fixture()
    expect(complete(registry, '')).toEqual({
      kind: 'values', prefix: '', replacementPrefix: '',
      candidates: ['--config', '--help', '-c', '-h', 'help', 'p', 'plain', 'project', 'repeat'],
    })
    expect(complete(registry, 'p').candidates).toEqual(['p', 'plain', 'project'])
    expect(complete(registry, '--f')).toEqual(empty('--f'))
    expect(complete(registry, '-c').candidates).toEqual(['-c'])
    expect(complete(registry, '-cpath')).toEqual(empty('-cpath'))
    expect(complete(registry, '-vh', '')).toEqual(empty())
  })

  test('static children and aliases win over an earlier dynamic parameter', () => {
    const { registry } = fixture()
    expect(complete(registry, 'p', 'l').candidates).toEqual(['list', 'ls'])
    const list = complete(registry, 'p', 'ls', '').candidates
    expect(list).toContain('--list-only')
    expect(list).not.toContain('--dynamic')
    const dynamic = complete(registry, 'p', 'some-id', '').candidates
    expect(dynamic).toContain('inspect')
    expect(dynamic).toContain('--dynamic')
    expect(dynamic).not.toContain(':id')
    expect(complete(registry, 'p', '').candidates).not.toContain(':id')
  })

  test('suggests inherited flags only while resolving nested aliases', () => {
    const { registry } = fixture()
    const root = complete(registry, 'project', '').candidates
    expect(root).toContain('--mode')
    expect(root).toContain('--format')
    expect(root).not.toContain('--depth')
    expect(root).not.toContain('--remote-only')
    const remote = complete(registry, 'p', 'r', '').candidates
    expect(remote).toContain('fetch')
    expect(remote).toContain('f')
    expect(remote).toContain('--remote-only')
    expect(remote).not.toContain('--depth')
    const leaf = complete(registry, 'p', 'r', 'f', '').candidates
    expect(leaf).toContain('--depth')
    expect(leaf).toContain('--mode')
    expect(leaf).not.toContain('fetch')
    expect(leaf).not.toContain('--list-only')
  })

  test('help, --help and -h route through root aliases and nested commands', () => {
    const { registry } = fixture()
    for (const help of ['help', '--help', '-h']) {
      expect(complete(registry, help, 'p').candidates).toEqual(['p', 'plain', 'project'])
      expect(complete(registry, help, 'p', 'r', 'f', '--dep').candidates).toEqual(['--depth'])
    }
    expect(complete(registry, 'help', 'help', '')).toEqual(empty())
  })

  test('consumes descendant option values before and between routes without treating them as routes', () => {
    const { registry } = fixture()
    expect(complete(registry, 'project', '--depth', 'list', 'r', '').candidates).toContain('fetch')
    expect(complete(registry, 'project', 'r', '-n', 'list', 'f', '--dep').candidates).toEqual(['--depth'])
    expect(complete(registry, 'project', '--depth', 'a')).toEqual({
      kind: 'values', prefix: 'a', replacementPrefix: '', candidates: ['all'],
    })
    expect(complete(registry, 'project', '--depth=all', 'r', 'f', '--dep').candidates).toEqual(['--depth'])
  })

  test('completes separate and attached enum values, retaining equals within the value', () => {
    const { registry } = fixture()
    expect(complete(registry, 'project', '--mode', 'fa')).toEqual({
      kind: 'values', prefix: 'fa', replacementPrefix: '', candidates: ['fast', 'fast=exact'],
    })
    expect(complete(registry, 'project', '--mode=fast=')).toEqual({
      kind: 'values', prefix: 'fast=', replacementPrefix: '--mode=', candidates: ['fast=exact'],
    })
    expect(complete(registry, 'project', '-m', 's').candidates).toEqual(['slow'])
    expect(complete(registry, 'project', '-mfa')).toEqual({
      kind: 'values', prefix: 'fa', replacementPrefix: '-m', candidates: ['fast', 'fast=exact'],
    })
    expect(complete(registry, 'project', '-m=fa')).toEqual({
      kind: 'values', prefix: '=fa', replacementPrefix: '-m', candidates: [],
    })
    expect(complete(registry, 'project', '--mode', '').candidates).toEqual(['$(literal)', 'fast', 'fast=exact', 'slow', 'two words'])
    expect(complete(registry, 'project', '--mode').candidates).toEqual(['--mode'])
  })

  test('boolean short clusters consume no route words and a string ends its cluster', () => {
    const { registry } = fixture()
    expect(complete(registry, 'project', '-vq', 'r', 'f', '--dep').candidates).toEqual(['--depth'])
    expect(complete(registry, 'project', '-vqm', 'list', 'r', '').candidates).toContain('fetch')
    expect(complete(registry, 'project', '-vqmfa')).toEqual({
      kind: 'values', prefix: 'fa', replacementPrefix: '-vqm', candidates: ['fast', 'fast=exact'],
    })
    expect(complete(registry, 'project', '-vqmfast', 'r', '').candidates).toContain('fetch')
    expect(complete(registry, 'project', '--verbose=true', '')).toEqual(empty())
    expect(complete(registry, 'project', '-vx', '')).toEqual(empty())
  })

  test('does not infer values for opaque string options or suggest routes in their place', () => {
    const { registry } = fixture()
    expect(complete(registry, 'project', '--opaque', 'l')).toEqual(empty('l'))
    expect(complete(registry, 'project', '--opaque=l')).toEqual({ ...empty('l'), replacementPrefix: '--opaque=' })
    expect(complete(registry, 'project', '-ol')).toEqual({ ...empty('l'), replacementPrefix: '-o' })
    expect(complete(registry, 'project', '--opaque', 'list', 'r', '').candidates).toContain('fetch')
    expect(complete(registry, 'project', '--mode', '--ver')).toEqual(empty('--ver'))
  })

  test('uses explicit filesystem modes without scanning or synthesizing path candidates', () => {
    const { registry } = fixture()
    expect(complete(registry, '--config', 'my path/')).toEqual({ kind: 'file', prefix: 'my path/', replacementPrefix: '', candidates: [] })
    expect(complete(registry, '--config=my path/')).toEqual({ kind: 'file', prefix: 'my path/', replacementPrefix: '--config=', candidates: [] })
    expect(complete(registry, 'project', '-cmy path/')).toEqual({ kind: 'file', prefix: 'my path/', replacementPrefix: '-c', candidates: [] })
    expect(complete(registry, 'project', '-dtmp/')).toEqual({ kind: 'directory', prefix: 'tmp/', replacementPrefix: '-d', candidates: [] })
    expect(complete(registry, 'project', '--directory', 'tmp/')).toEqual({ kind: 'directory', prefix: 'tmp/', replacementPrefix: '', candidates: [] })
  })

  test('extracts config before root and before command value parsing', () => {
    const { registry } = fixture()
    for (const prefix of [['--config', 'a.json'], ['--config=a.json'], ['-c', 'a.json']]) {
      expect(complete(registry, ...prefix, 'p', 'r', 'f', '--dep').candidates).toEqual(['--depth'])
    }
    expect(complete(registry, 'project', '--mode', '--config', 'a.json', 'list', 'r', '').candidates).toContain('fetch')
    expect(complete(registry, 'project', '--mode', '--config=a.json', 'fa').candidates).toEqual(['fast', 'fast=exact'])
    expect(complete(registry, '-cpath', 'p', '')).toEqual(empty())
    expect(complete(registry, '--config', '--mode', '')).toEqual(empty())
  })

  test('repeatable options consume flag-looking values before route parsing', () => {
    const { registry } = fixture()
    expect(complete(registry, 'repeat', '--tag', '--unknown', 'go', '--h').candidates).toEqual(['--help'])
    expect(complete(registry, 'repeat', '--tag=blue', '--tag', 'red', 'g').candidates).toEqual(['go'])
    expect(complete(registry, 'repeat', '--tag', 'b').candidates).toEqual(['blue'])
    expect(complete(registry, 'repeat', '--tag=b')).toEqual({ kind: 'values', prefix: 'b', replacementPrefix: '--tag=', candidates: ['blue'] })
    expect(complete(registry, 'repeat', '--raw', 'g')).toEqual(empty('g'))
    expect(complete(registry, 'repeat', '--raw', 'ignored', 'g').candidates).toEqual(['go'])
  })

  test('standalone -- stops all metadata completion, including pending values', () => {
    const { registry } = fixture()
    for (const head of [[], ['project'], ['project', '--mode'], ['repeat', '--raw']]) {
      expect(complete(registry, ...head, '--', '--config=x')).toEqual(empty('--config=x'))
    }
    expect(complete(registry, 'project', '--mode=--', 'r', 'f', '--dep').candidates).toEqual(['--depth'])
  })

  test('unknown roots and routes stop traversal, while handler positionals do not become routes', () => {
    const { registry } = fixture()
    expect(complete(registry, 'missing', '')).toEqual(empty())
    expect(complete(registry, 'project', 'r', 'missing', '')).toEqual(empty())
    expect(complete(registry, 'plain', 'arbitrary', '--h').candidates).toEqual(['--help'])
    expect(complete(registry, 'project', 'r', 'missing', '--config=x')).toEqual(empty('--config=x'))
  })

  test('ignores words after the cursor and supports an absent empty current word', () => {
    const { registry } = fixture()
    expect(completeWords(registry, ['tool', 'project', 'r', 'f', '--depth', 'all'], 2).candidates).toEqual(['r', 'remote'])
    expect(completeWords(registry, ['tool', 'project', 'r'], 3).candidates).toContain('fetch')
    expect(completeWords(registry, ['tool'], 0)).toEqual(empty('tool'))
    expect(completeWords(registry, ['tool'], 2)).toEqual(empty())
  })

  test('never calls hooks or target handlers, and observes the supplied registry each time', () => {
    const { registry, calls } = fixture()
    complete(registry, 'project', 'r', 'f', '')
    complete(registry, 'project', 'some-id', 'inspect', '')
    complete(registry, 'help', 'project', 'list', '')
    expect(calls).toEqual([])
    expect(complete([], 'p').candidates).toEqual([])
    expect(complete([registry[0]!], 'p').candidates).toEqual(['p', 'project'])
  })
})
