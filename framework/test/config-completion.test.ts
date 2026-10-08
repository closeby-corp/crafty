import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCommand } from '../src/command.ts'
import { completeWords } from '../src/completion.ts'
import type { CompletionProvider } from '../src/cli.ts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'crafty-values-'))
  const path = join(dir, 'config.json')
  await Bun.write(path, JSON.stringify({ environments: { production: ['web one', 'web two'], staging: ['preview'] } }))
  const calls: string[] = []
  const hosts: CompletionProvider = async ({ configPath, params }) => {
    calls.push('hosts')
    const config = await Bun.file(configPath ?? path).json()
    return config.environments[params.environment ?? 'production'] ?? []
  }
  const registry = [prepareCommand('deploy', {
    aliases: ['d'],
    init() { calls.push('init') },
    destroy() { calls.push('destroy') },
    options: [{ name: 'host', type: 'string', short: 'H', completion: hosts }],
    repeatable: ['host'],
    commands: {
      list: { run() { calls.push('run') } },
      ':environment': {
        async completion({ configPath }) {
          calls.push('environments')
          const config = await Bun.file(configPath ?? path).json()
          return Object.keys(config.environments)
        },
        commands: { ':host': { completion: hosts, run() { calls.push('run') } } },
      },
    },
  })]
  return { dir, path, registry, calls }
}

describe('configuration-backed completion', () => {
  test('loads fresh configuration for inherited option values and preserves attached forms', async () => {
    const { dir, path, registry, calls } = await fixture()
    try {
      for (const [word, replacementPrefix] of [['--host=web', '--host='], ['-Hweb', '-H']]) {
        const result = await completeWords(registry, ['tool', 'd', 'production', 'web one', word!], 4)
        expect(result).toEqual({ kind: 'values', prefix: 'web', replacementPrefix, candidates: ['web one', 'web two'] })
      }
      await Bun.write(path, JSON.stringify({ environments: { production: ['web three', 'web three', 'other'] } }))
      const result = await completeWords(registry, ['tool', 'deploy', 'list', '--host', 'web'], 4)
      expect(result.candidates).toEqual(['web three'])
      expect(calls).toEqual(['hosts', 'hosts', 'hosts'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('uses the last selected config before the cursor, not a later word or earlier query', async () => {
    const { dir, path, registry } = await fixture()
    try {
      const alternate = join(dir, 'alternate.json')
      await Bun.write(alternate, JSON.stringify({ environments: { production: ['alternate'] } }))
      for (const selection of [['--config', alternate], [`--config=${alternate}`], ['-c', alternate]]) {
        const words = ['tool', '--config', path, 'deploy', 'list', '--host', ...selection, '', '--config', path]
        expect((await completeWords(registry, words, 6 + selection.length)).candidates).toEqual(['alternate'])
      }
      expect((await completeWords(registry, ['tool', 'deploy', 'list', '--host', ''], 4)).candidates).toEqual(['web one', 'web two'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('completes configured route identifiers and scopes descendants to captured parameters', async () => {
    const { dir, registry, calls } = await fixture()
    try {
      expect((await completeWords(registry, ['tool', 'd', 'sta'], 2)).candidates).toEqual(['staging'])
      expect((await completeWords(registry, ['tool', 'd', 'staging', 'pre'], 3)).candidates).toEqual(['preview'])
      expect((await completeWords(registry, ['tool', 'd', 'list', '--host', 'web'], 4)).candidates).toEqual(['web one', 'web two'])
      expect(calls).toEqual(['environments', 'hosts', 'hosts'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('does not load configuration for flags, static routes, invalid routes, or -- tails; provider errors propagate', async () => {
    const { dir, path, registry, calls } = await fixture()
    try {
      await rm(path)
      expect((await completeWords(registry, ['tool', 'deploy', '--ho'], 2)).candidates).toEqual(['--host'])
      expect((await completeWords(registry, ['tool', 'deploy', 'list', '--h'], 3)).candidates).toEqual(['--help', '--host'])
      expect((await completeWords(registry, ['tool', 'missing', ''], 2)).candidates).toEqual([])
      expect((await completeWords(registry, ['tool', 'deploy', '--', ''], 3)).candidates).toEqual([])
      expect(calls).toEqual([])
      await expect(completeWords(registry, ['tool', 'deploy', 'list', '--host', ''], 4)).rejects.toThrow()
      expect(calls).toEqual(['hosts'])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test('uses route-local value metadata rather than an ancestor or sibling declaration', async () => {
    const registry = [prepareCommand('choose', {
      options: [{ name: 'target', type: 'string', completion: ['parent'] }],
      commands: {
        local: { options: [{ name: 'target', type: 'string', completion: () => ['local'] }], run() {} },
        sibling: { options: [{ name: 'target', type: 'string', completion: ['sibling'] }], run() {} },
      },
    })]
    expect((await completeWords(registry, ['tool', 'choose', 'local', '--target', ''], 4)).candidates).toEqual(['local'])
    expect((await completeWords(registry, ['tool', 'choose', 'sibling', '--target='], 3)).candidates).toEqual(['sibling'])
    expect((await completeWords(registry, ['tool', 'choose', '--target', ''], 3)).candidates).toEqual(['parent'])
  })
})
