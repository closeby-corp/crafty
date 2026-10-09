import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createSkillsPlugin } from '../src/plugins/skills.ts'
import { envelope, runCaptured } from './helpers/cli.ts'

const roots: string[] = []

interface FakeInstallerOptions {
  stdout?: string
  stdoutChunks?: Buffer[]
  stderr?: string
  code?: number
}

function mockInstaller({ stdout = '[]', stdoutChunks, stderr = '', code = 0 }: FakeInstallerOptions = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: (signal?: string) => boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => true
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => {
    queueMicrotask(() => {
      if (stdoutChunks) {
        for (const chunk of stdoutChunks) child.stdout.write(chunk)
        child.stdout.end()
      } else child.stdout.end(stdout)
      child.stderr.end(stderr)
      setTimeout(() => child.emit('close', code), 0)
    })
    return child as never
  }) as never)
  return { child, spawn }
}

async function makeCatalog(): Promise<{ root: string; content: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crafty-skills-plugin-')))
  roots.push(root)
  const content = '---\nname: sample\ndescription: A sample skill\n---\n\n# Sample skill\n\nUse this skill.\n'
  await mkdir(join(root, 'sample'))
  await writeFile(join(root, 'sample', 'SKILL.md'), content)
  return { root, content }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skills plugin', () => {
  test('factory and help stay lazy when the explicit source does not exist', async () => {
    const plugin = createSkillsPlugin({ skillsDir: '/path/that/does/not/exist' })
    const result = await runCaptured(plugin, ['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('List, inspect, and install local agent skills')
  })

  test('lists concise human rows and structured JSON records', async () => {
    const { root } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: pathToFileURL(`${root}/`) })

    const human = await runCaptured(plugin, ['list'])
    expect(human.code).toBe(0)
    expect(human.stdout).toBe('sample  A sample skill\n')

    const json = await runCaptured(plugin, ['list', '--json'])
    expect(envelope(json)).toMatchObject({ ok: true, data: [{ name: 'sample', description: 'A sample skill' }] })
  })

  test('shows raw Markdown for humans and the complete record in JSON', async () => {
    const { root, content } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: root })

    const human = await runCaptured(plugin, ['show', 'sample'])
    expect(human.code).toBe(0)
    expect(human.stdout).toBe(content)

    const json = await runCaptured(plugin, ['show', 'sample', '--json'])
    expect(envelope(json)).toMatchObject({ ok: true, data: { name: 'sample', content } })
  })

  test('dry-run previews only explicit selections and never adds implicit confirmation', async () => {
    const { root } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: root })
    const result = await runCaptured(plugin, ['install', '--dry-run', '--json', '--skill', 'sample', '--agent', 'cursor', '--global', '--copy'])
    const data = envelope(result).data as { version: string; source: string; target: string; skills: string[]; agents: string[]; argv: string[] }

    expect(data).toMatchObject({
      version: 'skills@1.7.1', source: root, target: 'global', skills: ['sample'], agents: ['cursor'],
    })
    expect(data.argv).toEqual([
      'x', '--bun', 'skills@1.7.1', 'add', root, '--skill', 'sample', '--agent', 'cursor', '--global', '--copy',
    ])
    expect(data.argv).not.toContain('--yes')
  })

  test('dry-run permits an interactive-selection preview without TTY or confirmation', async () => {
    const { root } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: root })
    const result = await runCaptured(plugin, ['install', '--dry-run'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('(interactive selection)')
    expect(result.stdout).not.toContain('--yes')
  })

  test('validates local skill names, agent identifiers, and extra arguments before install', async () => {
    const { root } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: root })

    const unknown = await runCaptured(plugin, ['install', '--dry-run', '--skill', 'missing', '--agent', 'cursor'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown skill')

    const unsafe = await runCaptured(plugin, ['install', '--dry-run', '--skill', 'sample', '--agent', '*'])
    expect(unsafe.code).toBe(2)
    expect(unsafe.stderr).toContain('invalid agent identifier')

    const extra = await runCaptured(plugin, ['install', '--dry-run', '--', 'unexpected'])
    expect(extra.code).toBe(2)
    expect(extra.stderr).toContain('does not accept positional arguments')
  })

  test('requires explicit selections and --yes when no interactive terminal is available', async () => {
    const { root } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: root })
    const result = await runCaptured(plugin, ['install', '--skill', 'sample', '--agent', 'cursor'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('requires --yes')
  })

  test('uses the pinned Bun installer in the project cwd and hides its captured output', async () => {
    const { root } = await makeCatalog()
    const { spawn } = mockInstaller({
      stdout: JSON.stringify([{ name: 'sample', status: 'installed', path: '/tmp/project/.agents/skills/sample', scope: 'project', agents: ['Codex'], mode: 'copy' }]),
      stderr: 'private installer progress',
    })
    try {
      const plugin = createSkillsPlugin({ skillsDir: root })
      const result = await runCaptured(plugin, ['install', '--skill', 'sample', '--agent', 'codex', '--yes', '--copy'])

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('Installed sample for codex')
      expect(result.stdout).not.toContain('private installer progress')
      expect(result.stdout).not.toContain('"status":"installed"')
      const [executable, argv, options] = spawn.mock.calls[0]!
      expect(executable).toBe(process.execPath)
      expect(argv).toEqual(['x', '--bun', 'skills@1.7.1', 'add', root, '--skill', 'sample', '--agent', 'codex', '--copy', '--yes', '--json'])
      expect(options).toMatchObject({ cwd: process.cwd(), shell: false, env: { INSTALL_INTERNAL_SKILLS: '0' } })
    } finally {
      spawn.mockRestore()
    }
  })

  test('returns upstream installed paths and scope in Crafty JSON', async () => {
    const { root } = await makeCatalog()
    const { spawn } = mockInstaller({
      stdout: JSON.stringify([{ name: 'sample', status: 'installed', path: '/tmp/project/.agents/skills/sample', scope: 'project', agents: ['Codex'], mode: 'copy' }]),
    })
    try {
      const plugin = createSkillsPlugin({ skillsDir: root })
      const result = await runCaptured(plugin, ['install', '--skill', 'sample', '--agent', 'codex', '--yes', '--json'])
      expect(envelope(result)).toMatchObject({
        ok: true,
        data: {
          version: 'skills@1.7.1', source: root, target: process.cwd(), exitCode: 0,
          installed: [{ name: 'sample', status: 'installed', path: '/tmp/project/.agents/skills/sample', scope: 'project', agents: ['Codex'], mode: 'copy' }],
        },
      })
    } finally {
      spawn.mockRestore()
    }
  })

  test('preserves UTF-8 characters split across installer output chunks', async () => {
    const { root } = await makeCatalog()
    const path = '/tmp/project/café/skills/sample'
    const bytes = Buffer.from(JSON.stringify([{ name: 'sample', status: 'installed', path, scope: 'project', agents: ['Codex'], mode: 'copy' }]))
    const boundary = bytes.indexOf(Buffer.from('é')) + 1
    const { spawn } = mockInstaller({ stdoutChunks: [bytes.subarray(0, boundary), bytes.subarray(boundary)] })
    try {
      const plugin = createSkillsPlugin({ skillsDir: root })
      const result = await runCaptured(plugin, ['install', '--skill', 'sample', '--agent', 'codex', '--yes', '--json'])
      expect(envelope(result)).toMatchObject({ ok: true, data: { installed: [{ path }] } })
    } finally {
      spawn.mockRestore()
    }
  })

  test('treats upstream failure, malformed JSON, and non-installed records as failures', async () => {
    const { root } = await makeCatalog()
    const plugin = createSkillsPlugin({ skillsDir: root })
    const scenarios = [
      { name: 'nonzero exit', stdout: '[]', stderr: 'installer failed', code: 1 },
      { name: 'malformed JSON', stdout: 'not json', code: 0 },
      { name: 'status failed despite zero exit', stdout: JSON.stringify([{ name: 'sample', status: 'failed', error: 'permission denied' }]), code: 0 },
      { name: 'missing selected skill despite zero exit', stdout: JSON.stringify([{ name: 'other', status: 'installed' }]), code: 0 },
    ]

    for (const scenario of scenarios) {
      const { spawn } = mockInstaller(scenario)
      try {
        const result = await runCaptured(plugin, ['install', '--skill', 'sample', '--agent', 'codex', '--yes', '--json'])
        expect(result.code).toBe(1)
        expect(envelope(result)).toMatchObject({ ok: false, error: { kind: 'upstream' } })
      } finally {
        spawn.mockRestore()
      }
    }
  })
})
