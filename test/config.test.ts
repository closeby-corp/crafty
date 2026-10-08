import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, OpsError } from '../src/errors.ts'
import {
  configTemplate,
  loadTargets,
  resolveConfigPath,
  resolveTarget,
  type Target,
  type TargetFile,
} from '../src/targets.ts'

const dir = mkdtempSync(join(tmpdir(), 'ops-config-'))
let counter = 0

function withConfig(text: string): string {
  counter += 1
  const path = join(dir, `config-${counter}.yml`)
  writeFileSync(path, text)
  return path
}

function problems(text: string): string[] {
  try {
    loadTargets({}, withConfig(text))
    return []
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
}

function file(text = configTemplate()): TargetFile {
  return loadTargets({}, withConfig(text))
}

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('the example configuration', () => {
  test('loads, with defaults filled in', () => {
    const loaded = file()
    expect(loaded.settings.timeout_ms).toBe(15_000)
    expect(loaded.settings.max_rows).toBe(200)
    expect(loaded.settings.data_dir).toBe('~/.cache/ops-cli')
    expect(loaded.ssh.hosts).toEqual(['uq-observability', 'uq-ingress-controller', 'uq-bi-worker'])
    // the seven separate Postgres targets became one db target with five lines
    expect(loaded.targets.size).toBe(10)

    const staging = loaded.targets.get('opensearch-staging')
    expect(staging?.kind).toBe('opensearch')
    expect(staging).toMatchObject({ time_field: '@timestamp', default_index: '*', auth: 'basic' })

    const signoz = loaded.targets.get('signoz')
    expect(signoz).toMatchObject({ via: 'ssh', logs_table: 'logs_v2', time_column: 'timestamp' })
  })

  test('keeps the default target for every kind', () => {
    const loaded = file()
    for (const [kind, name] of Object.entries(loaded.settings.default_targets)) {
      expect(loaded.targets.get(name)?.kind).toBe(kind as Target['kind'])
    }
  })

  test('a trailing slash on base_url is dropped', () => {
    const loaded = file(`targets:\n  x:\n    kind: prometheus\n    base_url: "https://prom.example.com/"\n    auth: none\n`)
    expect((loaded.targets.get('x') as { base_url: string }).base_url).toBe('https://prom.example.com')
  })
})

describe('db targets', () => {
  const loaded = file()

  test('the shipped set names its databases, each with a connector string', () => {
    const target = loaded.targets.get('apps') as { kind: string; databases: Record<string, string> }
    expect(target.kind).toBe('db')
    expect(Object.keys(target.databases)).toEqual(['agg', 'dt', 'sd', 'mm', 'om'])
    for (const [name, dsn] of Object.entries(target.databases)) {
      expect(dsn.startsWith('postgres://'), name).toBe(true)
      expect(dsn.includes('@'), name).toBe(true)
      expect(dsn.endsWith('REPLACE') || dsn.includes(':REPLACE@'), name).toBe(true)
    }
    expect(target.databases['om']).toContain('sd_order_manager')
  })

  test('the string is kept byte for byte, so a password with % or $ survives', () => {
    const dsn = "postgres://reader:p%24ss%22word@h:5432/d"
    const loaded = file(`targets:\n  x:\n    kind: db\n    databases:\n      d: "${dsn}"\n`)
    expect((loaded.targets.get('x') as { databases: Record<string, string> }).databases['d']).toBe(dsn)
  })

  test('a target with no databases, or a name a statement cannot use, is refused', () => {
    expect(problems('targets:\n  x:\n    kind: db\n')).toEqual([
      'targets.x: a db target needs at least one database in `databases`',
    ])
    expect(problems('targets:\n  x:\n    kind: db\n    databases: {}\n')).toEqual([
      'targets.x: a db target needs at least one database in `databases`',
    ])
    expect(problems('targets:\n  x:\n    kind: db\n    databases:\n      "om x": "postgres://u:p@h/d"\n')).toEqual([
      'targets.x: databases."om x": "om x" is not a name a statement can use',
    ])
  })

  test('a database whose string is not a connector string is refused, without echoing it', () => {
    const bad = problems('targets:\n  x:\n    kind: db\n    databases:\n      om: "mysql://u:p@h/d"\n')
    expect(bad).toEqual(['targets.x: databases.om: needs a postgres:// connector string'])

    const noUser = problems('targets:\n  x:\n    kind: db\n    databases:\n      om: "postgres://h:5432/d"\n')
    expect(noUser).toEqual(['targets.x: databases.om: the connector string carries no user'])

    // a credential in a malformed value never reaches the message
    const leak = problems('targets:\n  x:\n    kind: db\n    databases: "postgres://u:top-secret@h/d"\n')
    expect(leak.join(' ')).not.toContain('top-secret')
    expect(leak.join(' ')).toContain('[redacted]')
  })

  test('the old shape is rejected with the key that replaced it', () => {
    const stale = problems(
      `targets:\n  x:\n    kind: db\n    attaches:\n      - "ATTACH 'postgres://u:p@h/d' AS d (READ_ONLY)"\n`,
    )
    expect(stale).toEqual([
      'targets.x: unknown key "attaches" for a db target',
      'targets.x: a db target needs at least one database in `databases`',
    ])
  })
})

describe('validation', () => {
  test('an unknown kind names the known ones', () => {
    expect(problems(`targets:\n  x:\n    kind: elastic\n`)).toEqual([
      'targets.x: unknown kind "elastic"; known kinds: bitbucket, db, grafana, jira, kibana, opensearch, prometheus, signoz',
    ])
  })

  test('a missing required field is reported', () => {
    expect(problems(`targets:\n  x:\n    kind: opensearch\n    auth: none\n`)).toEqual(['targets.x: base_url is required'])
  })

  test('basic auth needs username and one credential', () => {
    expect(problems(`targets:\n  x:\n    kind: jira\n    base_url: "https://x"\n    auth: basic\n    username: me\n`)).toEqual([
      'targets.x: auth = "basic" needs username and one of password or secret',
    ])
  })

  test('a typo in a key is caught, because unknown keys are dead weight', () => {
    expect(
      problems(`targets:\n  x:\n    kind: kibana\n    baseurl: "https://x"\n    auth: none\n`),
    ).toEqual(['targets.x: unknown key "baseurl" for a kibana target', 'targets.x: base_url is required'])
  })

  test('a wrong type reports the value it saw', () => {
    expect(problems(`settings:\n  max_rows: many\n`)).toEqual([
      'settings: max_rows must be an integer between 1 and 9007199254740991, got "many"',
    ])
  })

  test('signoz refuses a transport other than ssh', () => {
    expect(
      problems(`targets:\n  s:\n    kind: signoz\n    via: http\n    ssh_host: h\n    container: c\n    database: d\n`),
    ).toEqual(['targets.s: via must be "ssh"; the container is only reachable over ssh'])
  })

  test('a default target that does not exist names the candidates', () => {
    expect(
      problems(
        [
          'settings:',
          '  default_targets:',
          '    kibana: nope',
          'targets:',
          '  kibana-iag:',
          '    kind: kibana',
          '    base_url: "https://x"',
          '    auth: none',
        ].join('\n'),
      ),
    ).toEqual(['settings.default_targets.kibana: "nope" is not a target; candidates of kind kibana: kibana-iag'])
  })

  test('a default target of the wrong kind is rejected', () => {
    expect(
      problems(
        [
          'settings:',
          '  default_targets:',
          '    kibana: jira',
          'targets:',
          '  jira:',
          '    kind: jira',
          '    base_url: "https://x"',
          '    auth: none',
        ].join('\n'),
      ),
    ).toEqual(['settings.default_targets.kibana: "jira" is a jira target'])
  })

  test('every problem is collected before anything is fixed', () => {
    const all = problems(`targets:\n  a:\n    kind: nope\n  b:\n    kind: opensearch\n    auth: none\n`)
    expect(all).toHaveLength(2)
    expect(all[0]).toStartWith('targets.a: unknown kind')
    expect(all[1]).toBe('targets.b: base_url is required')
  })

  test('a missing file says how to create one', () => {
    try {
      loadTargets({}, join(dir, 'absent.yml'))
      throw new Error('expected a ConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
    }
  })

  test('invalid YAML is reported with the path', () => {
    try {
      loadTargets({}, withConfig('targets: [\n'))
      throw new Error('expected a ConfigError')
    } catch (error) {
      expect((error as ConfigError).problems[0]).toContain('is not valid YAML')
    }
  })
})

describe('inline credentials', () => {
  test('a basic credential written in the file needs no store key', () => {
    const loaded = file(
      [
        'targets:',
        '  os:',
        '    kind: opensearch',
        '    base_url: "https://os.example.com"',
        '    auth: basic',
        '    username: ops',
        '    password: hunter2',
        '',
      ].join('\n'),
    )
    const target = loaded.targets.get('os') as { auth: string; username?: string; password?: string; secret?: string }
    expect(target).toMatchObject({ auth: 'basic', username: 'ops', password: 'hunter2' })
    expect(target.secret).toBeUndefined()
  })

  test('a bearer token written in the file needs no store key', () => {
    const loaded = file(
      [
        'targets:',
        '  g:',
        '    kind: grafana',
        '    base_url: "https://g.example.com"',
        '    auth: bearer',
        '    token: hunter2',
        '',
      ].join('\n'),
    )
    expect(loaded.targets.get('g')).toMatchObject({ auth: 'bearer', token: 'hunter2' })
  })

  test('giving both a password and a secret is refused', () => {
    expect(
      problems(
        `targets:\n  x:\n    kind: jira\n    base_url: "https://x"\n    auth: basic\n    username: me\n    password: p\n    secret: s\n`,
      ),
    ).toEqual(['targets.x: give one credential: password (basic), token (bearer) or secret (a store key)'])
  })

  test('auth = "none" refuses every credential and username', () => {
    expect(
      problems(`targets:\n  x:\n    kind: prometheus\n    base_url: "https://x"\n    auth: none\n    username: me\n`),
    ).toEqual(['targets.x: auth = "none" uses no credential; remove username/password/token/secret'])
  })
})

describe('the field catalog', () => {
  test('an opensearch target carries level_field and text_fields', () => {
    const loaded = file(
      [
        'targets:',
        '  os:',
        '    kind: opensearch',
        '    base_url: "https://os.example.com"',
        '    auth: none',
        '    level_field: log_level',
        '    text_fields:',
        '      - message',
        '      - msg',
        '',
      ].join('\n'),
    )
    expect(loaded.targets.get('os')).toMatchObject({ level_field: 'log_level', text_fields: ['message', 'msg'] })
  })
})

describe('path resolution', () => {
  test('--config wins over the environment', () => {
    expect(resolveConfigPath({ OPS_CONFIG: '/env/config.yml' }, '/cli/config.yml')).toBe('/cli/config.yml')
    expect(resolveConfigPath({ OPS_CONFIG: '/env/config.yml' })).toBe('/env/config.yml')
  })

  test('XDG_CONFIG_HOME is used when OPS_CONFIG is unset', () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/ops-cli/config.yml')
    expect(resolveConfigPath({}).endsWith('/.config/ops-cli/config.yml')).toBe(true)
  })

  test('a leading ~ expands', () => {
    expect(resolveConfigPath({}, '~/ops.yml').startsWith('~')).toBe(false)
  })
})

describe('target resolution', () => {
  const loaded = file()
  const nameOf = (target: Target | undefined) => target?.name

  test('an explicit name wins', () => {
    expect(nameOf(resolveTarget(loaded, 'opensearch', 'opensearch-production'))).toBe('opensearch-production')
  })

  test('the configured default is used when no name is given', () => {
    expect(nameOf(resolveTarget(loaded, 'kibana'))).toBe('kibana-iag')
  })

  test('the only target of a kind needs no default', () => {
    const single = file(`targets:\n  only:\n    kind: grafana\n    base_url: "https://g"\n    auth: none\n`)
    expect(nameOf(resolveTarget(single, 'grafana'))).toBe('only')
  })

  test('an unknown name lists the candidates as a hint', () => {
    try {
      resolveTarget(loaded, 'opensearch', 'nope')
      throw new Error('expected OpsError')
    } catch (error) {
      expect(error).toBeInstanceOf(OpsError)
      expect((error as OpsError).kind).toBe('config')
      expect((error as OpsError).hint).toContain('opensearch-staging, opensearch-production')
    }
  })

  test('a target of another kind is refused', () => {
    try {
      resolveTarget(loaded, 'opensearch', 'signoz')
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('config')
    }
  })

  test('an ambiguous kind demands --target', () => {
    const ambiguous = file(
      [
        'targets:',
        '  a:',
        '    kind: grafana',
        '    base_url: "https://a"',
        '    auth: none',
        '  b:',
        '    kind: grafana',
        '    base_url: "https://b"',
        '    auth: none',
      ].join('\n'),
    )
    try {
      resolveTarget(ambiguous, 'grafana')
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('config')
    }
  })

  test('a kind with no targets at all says so, and how to add one', () => {
    try {
      resolveTarget(file('settings:\n  timeout_ms: 1000\n'), 'prometheus')
      throw new Error('expected OpsError')
    } catch (error) {
      expect((error as OpsError).kind).toBe('config')
    }
  })
})
