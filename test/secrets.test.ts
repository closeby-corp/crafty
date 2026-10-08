import { afterEach, describe, expect, test } from 'bun:test'
import { redactString } from '../src/log.ts'
import { secretEnvName, targetCredential, type TargetCredential } from '../src/secrets.ts'

const VARIABLES = ['OPS_SECRET_OPS_CLI_TEST', 'OPS_SECRET_GRAFANA_BI', 'BITBUCKET_API_TOKEN', 'JIRA_API_TOKEN']

afterEach(() => {
  for (const key of VARIABLES) delete process.env[key]
})

describe('the variable a target names', () => {
  test('a `secret:` key becomes the name of an environment variable', () => {
    expect(secretEnvName('grafana-bi')).toBe('OPS_SECRET_GRAFANA_BI')
    expect(secretEnvName('ops.cli test')).toBe('OPS_SECRET_OPS_CLI_TEST')
  })
})

describe('where a credential comes from', () => {
  test('a value written in the file is used as it is', () => {
    const credential = targetCredential('opensearch', { password: 'from-the-file' })
    expect(credential).toMatchObject({ value: 'from-the-file', source: 'config' })
    expect(credential?.from).toBeUndefined()
  })

  test('a token is the same thing as a password', () => {
    expect(targetCredential('grafana', { token: 'glsa_abc' })).toMatchObject({ value: 'glsa_abc', source: 'config' })
  })

  test('the environment beats the file, and says which variable it read', () => {
    process.env['OPS_SECRET_GRAFANA_BI'] = 'from-the-env'
    expect(targetCredential('grafana', { secret: 'grafana-bi', token: 'from-the-file' })).toMatchObject({
      value: 'from-the-env',
      source: 'env',
      from: 'OPS_SECRET_GRAFANA_BI',
    })
  })

  test('bkt\'s two variables win over everything, for those two kinds only', () => {
    process.env['JIRA_API_TOKEN'] = 'bkt-token'
    process.env['OPS_SECRET_JIRA'] = 'other'
    expect(targetCredential('jira', { secret: 'jira', password: 'inline' })).toMatchObject({
      value: 'bkt-token',
      source: 'legacy-env',
      from: 'JIRA_API_TOKEN',
    })
    expect(targetCredential('grafana', { secret: 'grafana-bi', password: 'inline' })).toMatchObject({
      value: 'inline',
      source: 'config',
    })
  })

  test('nothing anywhere is null, never an empty string', () => {
    expect(targetCredential('opensearch', {})).toBeNull()
    expect(targetCredential('opensearch', { secret: 'ops-cli-test' })).toBeNull()
    expect(targetCredential('opensearch', { secret: 'ops-cli-test', password: '' })).toBeNull()
    process.env['OPS_SECRET_OPS_CLI_TEST'] = ''
    expect(targetCredential('opensearch', { secret: 'ops-cli-test' })).toBeNull()
  })

  test('a credential from either place is registered for redaction', () => {
    process.env['OPS_SECRET_OPS_CLI_TEST'] = 'redact-me-please'
    const fromEnv: TargetCredential = { secret: 'ops-cli-test' }
    targetCredential('opensearch', fromEnv)
    expect(redactString('it said redact-me-please out loud')).not.toContain('redact-me-please')

    const fromFile: TargetCredential = { password: 'also-secret-value' }
    targetCredential('opensearch', fromFile)
    expect(redactString('and also-secret-value too')).not.toContain('also-secret-value')
  })
})
