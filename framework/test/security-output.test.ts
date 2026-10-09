import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  commands, emitResult, gateMutation, log, OpsError, registerSecret, setCommands, setOutputSink,
  jsonReplacer, manifest, reportFailure, type CommandModule, type Ctx, type RegisteredCommand,
} from '../src/index.ts'
import { captureCli, envelope, runCaptured } from './helpers/cli.ts'

let previousSink: ((text: string) => void) | null = null
const registrySnapshots: RegisteredCommand[][] = []

beforeEach(() => {
  registrySnapshots.push(commands())
  previousSink = setOutputSink(null)
})

afterEach(() => {
  const snapshot = registrySnapshots.pop()
  if (snapshot) setCommands(snapshot)
  setOutputSink(previousSink)
})

describe('safe framework output', () => {
  test('redacts dry-run previews recursively without changing the planned request', async () => {
    const secret = 'review-fixture-secret'
    const planned = {
      method: 'POST',
      url: 'https://review-user:unregistered-url-password@example.invalid/api?token=url-query-secret&access_token=unregistered-access-token&client_secret=unregistered-client-secret',
      argv: [
        'tool', '--password', secret, '--token=unregistered-flag-secret',
        '-secret', 'unregistered-single-dash-secret', '--verbose',
      ],
      body: {
        account: { password: secret },
        headers: [{ authorization: `Bearer ${secret}` }],
        api_key: 'unregistered-api-key',
        note: secret,
      },
    }
    const original = structuredClone(planned)
    registerSecret(secret)
    const command: CommandModule = {
      name: 'dry-run-security',
      source: `source-${secret}`,
      options: [{ name: 'dry-run', type: 'boolean' }],
      run(ctx) {
        ctx.target = `https://target-user:${secret}@target.invalid`
        gateMutation(ctx, 'create user', planned)
      },
    }

    const json = await runCaptured(command, ['--dry-run', '--json'])
    expect(json.code).toBe(0)
    const output = json.stdout
    expect(envelope(json).data).toMatchObject({
      action: 'create user',
      request: {
        url: 'https://[redacted]@example.invalid/api?token=[redacted]&access_token=[redacted]&client_secret=[redacted]',
        command: 'tool --password [redacted] --token=[redacted] -secret [redacted] --verbose',
        body: {
          account: { password: '[redacted]' },
          headers: [{ authorization: '[redacted]' }],
          api_key: '[redacted]',
          note: '[redacted]',
        },
      },
    })
    expect(envelope(json)).toMatchObject({
      source: 'source-[redacted]',
      target: 'https://[redacted]@target.invalid',
    })
    expect(output).not.toContain(secret)
    expect(output).not.toContain('unregistered-url-password')
    expect(output).not.toContain('unregistered-flag-secret')
    expect(output).not.toContain('unregistered-access-token')
    expect(output).not.toContain('unregistered-client-secret')
    expect(output).not.toContain('unregistered-single-dash-secret')
    expect(planned).toEqual(original)

    const human = await runCaptured(command, ['--dry-run'])
    expect(human.code).toBe(0)
    expect(human.stdout).toContain('dry-run: create user')
    expect(human.stdout).not.toContain(secret)
    expect(human.stdout).not.toContain('unregistered-url-password')
    expect(human.stdout).not.toContain('unregistered-flag-secret')
    expect(human.stdout).not.toContain('unregistered-access-token')
    expect(human.stdout).not.toContain('unregistered-client-secret')
    expect(human.stdout).not.toContain('unregistered-single-dash-secret')
    expect(planned).toEqual(original)
  })

  test('uses client-declared sensitive argv spellings without guessing short options', () => {
    const declared = {
      argv: [
        'tool', '-p', 'separate-password', '-pattached-password',
        '--custom-key=attached-custom-secret', '--custom-key', 'separate-custom-secret',
      ],
      sensitiveArgvOptions: ['-p', '--custom-key'],
    }
    const original = structuredClone(declared)
    const preview = manifest(declared)
    expect(preview).toEqual({
      command: 'tool -p [redacted] -p[redacted] --custom-key=[redacted] --custom-key [redacted]',
    })
    expect(preview).not.toHaveProperty('sensitiveArgvOptions')
    expect(declared).toEqual(original)

    expect(manifest({ argv: ['tool', '-p', '8080', '-psecret'] })).toEqual({
      command: 'tool -p 8080 -psecret',
    })

    const registeredSecret = 'registered-arbitrary-option-secret'
    registerSecret(registeredSecret)
    expect(manifest({ argv: ['tool', '-x', registeredSecret] })).toEqual({
      command: 'tool -x [redacted]',
    })
  })

  test('redacts compound credential names in separate and attached argv forms', () => {
    const preview = manifest({
      argv: [
        'tool', '--access-token', 'separate-access-token',
        '--access-token=attached-access-token', '--client-secret', 'separate-client-secret',
        '--client-secret=attached-client-secret',
      ],
    })
    expect(preview).toEqual({
      command: 'tool --access-token [redacted] --access-token=[redacted] --client-secret [redacted] --client-secret=[redacted]',
    })
    expect(JSON.stringify(preview)).not.toContain('separate-access-token')
    expect(JSON.stringify(preview)).not.toContain('attached-access-token')
    expect(JSON.stringify(preview)).not.toContain('separate-client-secret')
    expect(JSON.stringify(preview)).not.toContain('attached-client-secret')
  })

  test('preserves copied dates, scalar values, and BigInt in recursive body previews', () => {
    const date = new Date('2026-10-09T00:00:00.000Z')
    const preview = manifest({
      body: {
        at: date,
        count: 42n,
        enabled: true,
        label: 'scheduled',
        secret_date: new Date('2026-10-10T00:00:00.000Z'),
      },
    })
    const body = preview.body as Record<string, unknown>

    expect(body.at).toEqual(date)
    expect(body.at).not.toBe(date)
    expect(body.count).toBe(42n)
    expect(body.enabled).toBe(true)
    expect(body.label).toBe('scheduled')
    expect(body.secret_date).toBe('[redacted]')
    expect(JSON.stringify(preview, jsonReplacer)).toContain('"at":"2026-10-09T00:00:00.000Z"')
    expect(JSON.stringify(preview, jsonReplacer)).toContain('"count":42')
    expect(date.toISOString()).toBe('2026-10-09T00:00:00.000Z')
  })

  test('redacts registered secrets in primary errors and hints in JSON and human output', async () => {
    const secret = 'review-error-secret'
    registerSecret(secret)
    const command: CommandModule = {
      name: 'failure-security',
      run() { throw new OpsError(`request rejected: ${secret}`, 'auth', { hint: `check credential ${secret}` }) },
    }

    const json = await runCaptured(command, ['--json'])
    expect(json.code).toBe(3)
    expect(envelope(json)).toMatchObject({
      ok: false,
      error: { kind: 'auth', message: 'request rejected: [redacted]', hint: 'check credential [redacted]' },
    })
    expect(json.stdout).not.toContain(secret)

    const human = await runCaptured(command, [])
    expect(human.code).toBe(3)
    expect(human.stderr).toContain('request rejected: [redacted]')
    expect(human.stderr).toContain('hint: check credential [redacted]')
    expect(human.stderr).not.toContain(secret)
  })

  test('redacts diagnostic source, target, route and usage while preserving ordinary wording', async () => {
    const secret = 'review-context-secret'
    registerSecret(secret)
    const info = { source: `source-${secret}`, path: `route ${secret}`, usage: [`usage ${secret}`, 'password required'] }
    const context = (json: boolean): Ctx => ({
      source: info.source,
      target: `https://operator:${secret}@example.invalid`,
      json,
      format: 'auto',
      color: false,
      verbose: false,
      startedAt: Date.now(),
      path: info.path,
      usage: info.usage,
      values: {},
      positionals: [],
      tail: [],
      repeat: {},
      params: {},
      state: {},
    })

    const json = await captureCli(async () => reportFailure(
      new OpsError('password required', 'usage', { hint: 'password required' }),
      info,
      context(true),
      [],
    ))
    expect(envelope(json)).toMatchObject({
      source: 'source-[redacted]',
      target: 'https://[redacted]@example.invalid',
      error: { message: 'password required', hint: 'password required' },
    })
    expect(json.stdout).not.toContain(secret)

    const human = await captureCli(async () => reportFailure(
      new OpsError('password required', 'usage', { hint: 'password required' }),
      info,
      context(false),
      [],
    ))
    expect(human.stderr).toContain('route [redacted]: password required')
    expect(human.stderr).toContain('hint: password required')
    expect(human.stderr).toContain('usage [redacted]')
    expect(human.stderr).toContain('password required')
    expect(human.stderr).not.toContain(secret)
  })

  test('writes info diagnostics to stderr while JSON remains valid captured stdout', async () => {
    const command: CommandModule = {
      name: 'logging-security',
      run(ctx) {
        log.info('progress')
        emitResult(ctx, { complete: true })
      },
    }
    const result = await runCaptured(command, ['--json'])

    expect(result.stdout).not.toContain('progress')
    expect(envelope(result)).toMatchObject({ ok: true, data: { complete: true } })
    expect(result.stderr).toContain('"level":"info"')
    expect(result.stderr).toContain('"msg":"progress"')
  })

  test('captures direct framework logger writes without contaminating output sinks', async () => {
    let stdout = ''
    const stderr: string[] = []
    const outer = setOutputSink((text) => { stdout += text })
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    })
    try {
      log.debug('captured diagnostic')
      expect(stdout).toBe('')
      expect(stderr.join('')).toContain('captured diagnostic')
    } finally {
      setOutputSink(outer)
      spy.mockRestore()
    }
  })
})
