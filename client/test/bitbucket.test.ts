import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bitbucketCommand from '../commands/bitbucket.ts'
import { resetConfigCache } from '../lib/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { startMockServer, type MockServer } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-bb-'))
const binDir = join(scratch, 'bin')
const gitLog = join(scratch, 'git.log')
const configPath = join(scratch, 'config.yml')
const cloneRoot = join(scratch, 'repos')
const originalPath = process.env['PATH']

/** A `git` that records its argv and answers the read verbs the CLI asks for. */
const FAKE_GIT = `#!/bin/sh
if [ -n "$FAKE_GIT_LOG" ]; then printf '%s %s\\n' "$(pwd -P)" "$*" >> "$FAKE_GIT_LOG"; fi
last=''
for a in "$@"; do last="$a"; done
case "$*" in
  *" clone "*) mkdir -p "$last"; exit 0 ;;
esac
case "$*" in
  *"status --porcelain -b"*) printf '%s' "$FAKE_GIT_STATUS" ;;
  *"rev-parse --abbrev-ref HEAD"*) printf '%s\\n' "$FAKE_GIT_BRANCH" ;;
  *"apply --stat"*) printf '%s' "$FAKE_GIT_STAT" ;;
  *) printf '%s' "$FAKE_GIT_OUT" ;;
esac
exit 0
`

const REPO = {
  slug: 'uq-api',
  name: 'uq-api',
  is_private: true,
  updated_on: '2026-10-01T00:00:00+00:00',
  workspace: { slug: 'craftablesoftware' },
}

const REPO_ROW = {
  workspace: 'craftablesoftware',
  slug: 'uq-api',
  name: 'uq-api',
  private: true,
  updated_on: '2026-10-01T00:00:00+00:00',
}

const PIPELINE = {
  uuid: '{11111111-2222-3333-4444-555555555555}',
  build_number: 42,
  state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
  target: { ref_name: 'main' },
  created_on: '2026-10-01T10:00:00+00:00',
  duration_in_seconds: 61,
}

const PR = {
  id: 7,
  title: 'Fix the thing',
  state: 'OPEN',
  source: { branch: { name: 'feat/x' } },
  destination: { branch: { name: 'main' } },
  author: { display_name: 'Tiago' },
  updated_on: '2026-10-02T10:00:00+00:00',
}

beforeAll(() => {
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'git'), FAKE_GIT)
  chmodSync(join(binDir, 'git'), 0o755)
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`
  process.env['FAKE_GIT_LOG'] = gitLog
})

afterAll(() => {
  if (originalPath === undefined) delete process.env['PATH']
  else process.env['PATH'] = originalPath
  delete process.env['FAKE_GIT_LOG']
  rmSync(scratch, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_MOCK']
  delete process.env['FAKE_GIT_STATUS']
  delete process.env['FAKE_GIT_BRANCH']
  delete process.env['FAKE_GIT_STAT']
  delete process.env['FAKE_GIT_OUT']
  writeFileSync(gitLog, '')
  rmSync(cloneRoot, { recursive: true, force: true })
  resetConfigCache()
})

afterEach(() => {
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_MOCK']
  resetConfigCache()
})

/** A one-target config pointing at the mock server. */
function configure(url: string, auth: { auth?: string; username?: string; secret?: string } = {}): void {
  writeFileSync(
    configPath,
    [
      'settings:',
      `  data_dir: "${scratch}"`,
      'targets:',
      '  mock:',
      '    kind: bitbucket',
      `    base_url: "${url}"`,
      '    workspace: craftablesoftware',
      `    auth: ${auth.auth ?? 'none'}`,
      ...(auth.username === undefined ? [] : [`    username: ${auth.username}`]),
      ...(auth.secret === undefined ? [] : [`    secret: ${auth.secret}`]),
      '',
    ].join('\n'),
  )
  process.env['OPS_CONFIG'] = configPath
  resetConfigCache()
}

function bb(argv: string[]): Promise<CliCapture> {
  return runCaptured(bitbucketCommand, argv)
}

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

function dataOf(capture: CliCapture): unknown {
  return envelope(capture)['data']
}

/** Each `git` invocation: the directory it ran in, and its arguments. */
function gitCalls(): Array<{ cwd: string; argv: string }> {
  return readFileSync(gitLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const space = line.indexOf(' ')
      return { cwd: line.slice(0, space), argv: line.slice(space + 1) }
    })
}

function gitLines(): string[] {
  return gitCalls().map((call) => call.argv)
}

/** `?a=b&c=d` as the server recorded it, decoded. */
function queryOf(request: { query: string }): URLSearchParams {
  return new URLSearchParams(request.query.startsWith('?') ? request.query.slice(1) : request.query)
}

function makeClone(): string {
  const dir = join(cloneRoot, 'craftablesoftware', 'uq-api')
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------ *
 * repo
 * ------------------------------------------------------------------ */

describe('ops bb repo list', () => {
  test('lists repositories with the page size and the row shape', async () => {
    const server = startMockServer([{ path: '/repositories/craftablesoftware', body: { values: [REPO] } }])
    configure(server.url)
    const capture = await bb(['repo', 'list', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.method).toBe('GET')
    expect(server.requests[0]!.path).toBe('/repositories/craftablesoftware')
    expect(queryOf(server.requests[0]!).get('pagelen')).toBe('100')
    expect(dataOf(capture)).toEqual([REPO_ROW])
  })

  test('--query becomes a Bitbucket name filter', async () => {
    const server = startMockServer([{ path: '/repositories/craftablesoftware', body: { values: [] } }])
    configure(server.url)
    await bb(['repo', 'list', '--query', 'api', '--json'])
    expect(queryOf(server.requests[0]!).get('q')).toBe('name~"api"')
  })

  /** Page one carries a `next` back to the same path; page two is the last. */
  function startPagingServer(): MockServer {
    let url = ''
    const server = startMockServer([
      {
        path: '/repositories/craftablesoftware',
        handler: (_request, seen) =>
          seen === 0
            ? { body: { values: [REPO], next: `${url}/repositories/craftablesoftware?page=2` } }
            : { body: { values: [{ ...REPO, slug: 'uq-web' }] } },
      },
    ])
    url = server.url
    return server
  }

  test('--all follows next', async () => {
    const server = startPagingServer()
    configure(server.url)
    const capture = await bb(['repo', 'list', '--all', '--json'])
    expect((dataOf(capture) as unknown[]).length).toBe(2)
    expect(server.requests.length).toBe(2)
    expect(server.requests[1]!.path).toBe('/repositories/craftablesoftware')
    expect(server.requests[1]!.query).toBe('?page=2')
  })

  test('without --all the result is truncated', async () => {
    const server = startPagingServer()
    configure(server.url)
    const capture = await bb(['repo', 'list', '--json'])
    expect(capture.code).toBe(0)
    expect((dataOf(capture) as unknown[]).length).toBe(1)
    expect((envelope(capture)['meta'] as Record<string, unknown>)['truncated']).toBe(true)
    expect(server.requests.length).toBe(1)
  })
})

describe('ops bb repo view', () => {
  test('resolves a bare slug against the target workspace', async () => {
    const server = startMockServer([{ path: '/repositories/craftablesoftware/uq-api', body: REPO }])
    configure(server.url)
    const capture = await bb(['repo', 'view', 'uq-api', '--json'])
    expect(capture.code).toBe(0)
    expect((dataOf(capture) as Record<string, unknown>)['slug']).toBe('uq-api')
  })

  test('uses the Basic auth header the target carries', async () => {
    process.env['OPS_SECRET_MOCK'] = 'hunter2'
    const server = startMockServer([{ path: '/repositories/craftablesoftware/uq-api', body: REPO }])
    configure(server.url, { auth: 'basic', username: 'ops', secret: 'mock' })
    await bb(['repo', 'view', 'uq-api', '--json'])
    const expected = `Basic ${Buffer.from('ops:hunter2').toString('base64')}`
    expect(server.requests[0]!.headers['authorization']).toBe(expected)
  })

  test('sends an OAuth access token as a Bearer header, with no username', async () => {
    // Bitbucket Cloud accepts either an Atlassian API token over Basic (email +
    // token) or an OAuth 2.0 access token over Bearer.
    process.env['OPS_SECRET_MOCK'] = 'eyJhbGciOiJIUzI1NiJ9.access'
    const server = startMockServer([{ path: '/repositories/craftablesoftware', body: { values: [REPO] } }])
    configure(server.url, { auth: 'bearer', secret: 'mock' })
    const capture = await bb(['repo', 'list', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.headers['authorization']).toBe('Bearer eyJhbGciOiJIUzI1NiJ9.access')
  })

  test('maps a 404 to not-found', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/nope', status: 404, body: { error: { message: 'Repository not found' } } },
    ])
    configure(server.url)
    const capture = await bb(['repo', 'view', 'nope', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('not-found')
    expect(errorOf(capture)['message']).toBe('Repository not found')
  })

  test('maps a 401 to auth', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api', status: 401, body: { error: { message: 'Unauthorized' } } },
    ])
    configure(server.url)
    const capture = await bb(['repo', 'view', 'uq-api', '--json'])
    expect(capture.code).toBe(3)
    expect(errorOf(capture)['kind']).toBe('auth')
  })

  test('maps a 500 to upstream', async () => {
    const server = startMockServer([{ path: '/repositories/craftablesoftware/uq-api', status: 500, body: { message: 'boom' } }])
    configure(server.url)
    const capture = await bb(['repo', 'view', 'uq-api', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('upstream')
  })
})

describe('ops bb repo clone', () => {
  test('clones over ssh into data_dir', async () => {
    const server = startMockServer([])
    configure(server.url)
    const capture = await bb(['repo', 'clone', 'craftablesoftware/uq-api', '--json'])
    expect(capture.code).toBe(0)
    const dir = join(cloneRoot, 'craftablesoftware', 'uq-api')
    expect(gitLines()).toEqual([`clone git@bitbucket.org:craftablesoftware/uq-api.git ${dir}`])
    expect((dataOf(capture) as Record<string, unknown>)['dir']).toBe(dir)
  })

  test('skips an existing clone unless --force', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    const skipped = await bb(['repo', 'clone', 'craftablesoftware/uq-api', '--json'])
    expect((dataOf(skipped) as Record<string, unknown>)['skipped']).toBe(true)
    expect(gitLines()).toEqual([])

    await bb(['repo', 'clone', 'craftablesoftware/uq-api', '--force', '--json'])
    expect(gitLines().length).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * pipeline
 * ------------------------------------------------------------------ */

describe('ops bb pipeline', () => {
  test('list asks for the newest first', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pipelines/', body: { values: [PIPELINE] } },
    ])
    configure(server.url)
    const capture = await bb(['pipeline', 'list', '--repo', 'craftablesoftware/uq-api', '--json'])
    expect(capture.code).toBe(0)
    expect(queryOf(server.requests[0]!).get('sort')).toBe('-created_on')
    expect((dataOf(capture) as Record<string, unknown>[])[0]).toEqual({
      uuid: PIPELINE.uuid,
      build_number: 42,
      state: 'COMPLETED',
      result: 'SUCCESSFUL',
      branch: 'main',
      created_on: '2026-10-01T10:00:00+00:00',
      duration_s: 61,
    })
  })

  test('logs returns the raw text', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pipelines/u1/log', body: 'line one\nline two\n' },
    ])
    configure(server.url)
    const capture = await bb(['pipeline', 'logs', '--repo', 'craftablesoftware/uq-api', 'u1'])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toBe('line one\nline two\n')
  })

  test('run assembles the branch target body', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pipelines/', status: 201, body: PIPELINE },
    ])
    configure(server.url)
    const capture = await bb([
      'pipeline', 'run', '--repo', 'craftablesoftware/uq-api', '--branch', 'main', '--var', 'A=1', '--yes', '--json',
    ])
    expect(capture.code).toBe(0)
    const request = server.requests[0]!
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body)).toEqual({
      target: { ref_type: 'branch', type: 'pipeline', ref_name: 'main' },
      variables: [{ key: 'A', value: '1' }],
    })
  })

  test('run maps 429 to rate-limit without retrying the write', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pipelines/', status: 429, body: { error: { message: 'slow down' } } },
    ])
    configure(server.url)
    const capture = await bb(['pipeline', 'run', '--repo', 'craftablesoftware/uq-api', '--branch', 'main', '--yes', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('rate-limit')
    expect(server.requests.length).toBe(1)
  })

  test('stop uses stopPipeline when it answers', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pipelines/u1/stopPipeline', body: { state: 'STOPPED' } },
    ])
    configure(server.url)
    const capture = await bb(['pipeline', 'stop', '--repo', 'craftablesoftware/uq-api', 'u1', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(server.of('POST').length).toBe(1)
    expect(server.of('PUT').length).toBe(0)
  })

  test('stop falls back to the PUT when stopPipeline 404s', async () => {
    const server = startMockServer([
      {
        path: '/repositories/craftablesoftware/uq-api/pipelines/u1/stopPipeline',
        status: 404,
        body: { error: { message: 'no such route' } },
      },
      { path: '/repositories/craftablesoftware/uq-api/pipelines/u1', body: { target_state: 'STOPPED' } },
    ])
    configure(server.url)
    const capture = await bb(['pipeline', 'stop', '--repo', 'craftablesoftware/uq-api', 'u1', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(server.of('POST').length).toBe(1)
    expect(server.of('PUT').length).toBe(1)
    expect(JSON.parse(server.of('PUT')[0]!.body)).toEqual({ target_state: 'STOPPED' })
    expect((dataOf(capture) as Record<string, unknown>)['http_status']).toBe(200)
  })
})

/* ------------------------------------------------------------------ *
 * pr
 * ------------------------------------------------------------------ */

describe('ops bb pr', () => {
  test('list composes the state and branch filters', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pullrequests', body: { values: [PR] } },
    ])
    configure(server.url)
    const capture = await bb([
      'pr', 'list', '--repo', 'craftablesoftware/uq-api', '--state', 'MERGED', '--source', 'feat/x', '--target', 'main', '--json',
    ])
    expect(capture.code).toBe(0)
    const query = queryOf(server.requests[0]!)
    expect(query.get('state')).toBe('MERGED')
    expect(query.get('q')).toBe('source.branch.name="feat/x" AND destination.branch.name="main"')
    expect((dataOf(capture) as Record<string, unknown>[])[0]).toEqual({
      id: 7,
      title: 'Fix the thing',
      state: 'OPEN',
      source: 'feat/x',
      destination: 'main',
      author: 'Tiago',
      updated_on: '2026-10-02T10:00:00+00:00',
    })
  })

  test('list rejects an unknown state before contacting anything', async () => {
    const server = startMockServer([])
    configure(server.url)
    const capture = await bb(['pr', 'list', '--repo', 'craftablesoftware/uq-api', '--state', 'WAT', '--json'])
    expect(capture.code).toBe(2)
    expect(errorOf(capture)['kind']).toBe('usage')
    expect(server.requests.length).toBe(0)
  })

  test('view --comments adds the comment rows', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pullrequests/7', body: PR },
      {
        path: '/repositories/craftablesoftware/uq-api/pullrequests/7/comments',
        body: { values: [{ id: 1, author: { display_name: 'Tiago' }, content: { raw: 'ok' }, created_on: '2026-10-02T11:00:00+00:00' }] },
      },
    ])
    configure(server.url)
    const capture = await bb(['pr', 'view', '--repo', 'craftablesoftware/uq-api', '7', '--comments', '--json'])
    expect(capture.code).toBe(0)
    expect((dataOf(capture) as Record<string, unknown>)['comments']).toEqual([
      { id: 1, author: 'Tiago', body: 'ok', created_on: '2026-10-02T11:00:00+00:00' },
    ])
  })

  test('create sends the destination default and reviewers', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pullrequests', status: 201, body: PR },
    ])
    configure(server.url)
    const capture = await bb([
      'pr', 'create', '--repo', 'craftablesoftware/uq-api', '--title', 'Fix', '--source', 'feat/x', '--reviewer', 'u1',
      '--reviewer', 'u2', '--close-source-branch', '--yes', '--json',
    ])
    expect(capture.code).toBe(0)
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      title: 'Fix',
      source: { branch: { name: 'feat/x' } },
      destination: { branch: { name: 'main' } },
      reviewers: [{ uuid: 'u1' }, { uuid: 'u2' }],
      close_source_branch: true,
    })
  })

  test('comment posts the raw body', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pullrequests/7/comments', status: 201, body: { id: 9 } },
    ])
    configure(server.url)
    const capture = await bb(['pr', 'comment', '--repo', 'craftablesoftware/uq-api', '7', '--text', 'looks good', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ content: { raw: 'looks good' } })
  })

  test('approve posts to the approve route', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pullrequests/7/approve', body: PR },
    ])
    configure(server.url)
    const capture = await bb(['pr', 'approve', '--repo', 'craftablesoftware/uq-api', '7', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.path).toBe('/repositories/craftablesoftware/uq-api/pullrequests/7/approve')
  })

  test('diff prints the raw text, and --stat pipes it through git', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/pullrequests/7/diff', body: 'diff --git a/x b/x\n' },
    ])
    configure(server.url)
    const capture = await bb(['pr', 'diff', '--repo', 'craftablesoftware/uq-api', '7'])
    expect(capture.code).toBe(0)
    expect(capture.stdout).toBe('diff --git a/x b/x\n')

    process.env['FAKE_GIT_STAT'] = ' x | 2 +-\n'
    const stat = await bb(['pr', 'diff', '--repo', 'craftablesoftware/uq-api', '7', '--stat'])
    expect(stat.code).toBe(0)
    expect(stat.stdout).toBe(' x | 2 +-\n')
    expect(gitLines().some((line) => line.includes('apply --stat -'))).toBe(true)
    // A pull-request diff belongs to no repository here, and `git apply` reports
    // 0 files for a foreign diff when it is run from inside one.
    const statCall = gitCalls().find((call) => call.argv.includes('apply --stat -'))!
    expect(statCall.cwd).toBe(tmpdir())
  })

  test('merge polls the task a 202 points at', async () => {
    let url = ''
    const server = startMockServer([
      {
        path: '/repositories/craftablesoftware/uq-api/pullrequests/7/merge',
        handler: () => ({ status: 202, body: { links: { self: { href: `${url}/repositories/craftablesoftware/uq-api/pullrequests/7/merge/task/9` } } } }),
      },
      {
        path: '/repositories/craftablesoftware/uq-api/pullrequests/7/merge/task/9',
        body: { task_status: 'SUCCESS', merge_result: true },
      },
    ])
    url = server.url
    configure(url)
    const capture = await bb(['pr', 'merge', '--repo', 'craftablesoftware/uq-api', '7', '--strategy', 'squash', '--wait', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests.length).toBe(2)
    expect(server.requests[1]!.method).toBe('GET')
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ merge_strategy: 'squash' })
    expect(dataOf(capture)).toEqual({ id: '7', http_status: 202, task_status: 'SUCCESS', merge_result: true })
  })

  test('merge tolerates a task body without the fields', async () => {
    let url = ''
    const server = startMockServer([
      {
        path: '/repositories/craftablesoftware/uq-api/pullrequests/7/merge',
        handler: () => ({ status: 202, body: { links: { self: { href: `${url}/repositories/craftablesoftware/uq-api/pullrequests/7/merge/task/9` } } } }),
      },
      { path: '/repositories/craftablesoftware/uq-api/pullrequests/7/merge/task/9', body: {} },
    ])
    url = server.url
    configure(url)
    const capture = await bb(['pr', 'merge', '--repo', 'craftablesoftware/uq-api', '7', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(dataOf(capture)).toEqual({ id: '7', http_status: 202, task_status: null, merge_result: null })
  })

  test('merge --wait fails when the task reports a failure', async () => {
    let url = ''
    const server = startMockServer([
      {
        path: '/repositories/craftablesoftware/uq-api/pullrequests/7/merge',
        handler: () => ({ status: 202, body: { links: { self: { href: `${url}/repositories/craftablesoftware/uq-api/pullrequests/7/merge/task/9` } } } }),
      },
      { path: '/repositories/craftablesoftware/uq-api/pullrequests/7/merge/task/9', body: { task_status: 'FAILED', merge_result: false } },
    ])
    url = server.url
    configure(url)
    const capture = await bb(['pr', 'merge', '--repo', 'craftablesoftware/uq-api', '7', '--wait', '--yes', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('conflict')
  })
})

/* ------------------------------------------------------------------ *
 * branch
 * ------------------------------------------------------------------ */

describe('ops bb branch', () => {
  test('list filters by name', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/refs/branches', body: { values: [{ name: 'main', target: { hash: 'abc', date: '2026-10-01' } }] } },
    ])
    configure(server.url)
    const capture = await bb(['branch', 'list', '--repo', 'craftablesoftware/uq-api', '--filter', 'ma', '--json'])
    expect(capture.code).toBe(0)
    expect(queryOf(server.requests[0]!).get('q')).toBe('name~"ma"')
    expect((dataOf(capture) as Record<string, unknown>[])[0]).toEqual({ name: 'main', hash: 'abc', date: '2026-10-01' })
  })

  test('create resolves --from to a hash before posting', async () => {
    const server = startMockServer([
      { path: '/repositories/craftablesoftware/uq-api/commit/main', body: { hash: 'abc123' } },
      { path: '/repositories/craftablesoftware/uq-api/refs/branches', status: 201, body: { name: 'feature' } },
    ])
    configure(server.url)
    const capture = await bb([
      'branch', 'create', '--repo', 'craftablesoftware/uq-api', 'feature', '--from', 'main', '--yes', '--json',
    ])
    expect(capture.code).toBe(0)
    expect(server.of('GET')[0]!.path).toBe('/repositories/craftablesoftware/uq-api/commit/main')
    expect(JSON.parse(server.of('POST')[0]!.body)).toEqual({ name: 'feature', target: { hash: 'abc123' } })
  })

  test('delete URL-encodes the branch name', async () => {
    const server = startMockServer([{ path: '/repositories/craftablesoftware/uq-api/refs/branches/feature%2Fx', body: {} }])
    configure(server.url)
    const capture = await bb(['branch', 'delete', '--repo', 'craftablesoftware/uq-api', 'feature/x', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(server.of('DELETE').length).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * local clone
 * ------------------------------------------------------------------ */

describe('ops bb status/commit/push', () => {
  test('status parses the porcelain header', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    process.env['FAKE_GIT_STATUS'] = '## main...origin/main [ahead 1, behind 2]\n M src/x.ts\n'
    const capture = await bb(['status', 'craftablesoftware/uq-api', '--json'])
    expect(capture.code).toBe(0)
    expect(dataOf(capture)).toEqual({
      repo: 'craftablesoftware/uq-api',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
      clean: false,
      changes: [' M src/x.ts'],
    })
  })

  test('status needs a clone and points at repo clone', async () => {
    const server = startMockServer([])
    configure(server.url)
    const capture = await bb(['status', 'craftablesoftware/uq-api', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('config')
  })

  test('commit stages everything and applies the author identity', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    const capture = await bb([
      'commit', 'craftablesoftware/uq-api', '-m', 'initial', '--yes', '--author', 'Ops <ops@x>', '--json',
    ])
    expect(capture.code).toBe(0)
    const lines = gitLines()
    expect(lines[0]).toBe('-c user.name=Ops -c user.email=ops@x add -A')
    expect(lines[1]).toBe('-c user.name=Ops -c user.email=ops@x commit -m initial')
  })

  test('commit --files stages only those paths', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    await bb(['commit', 'craftablesoftware/uq-api', '-m', 'fix', '--files', 'src/a.ts,src/b.ts', '--yes', '--json'])
    expect(gitLines()[0]).toBe('add -- src/a.ts src/b.ts')
  })

  test('push defaults to the checked-out branch', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    process.env['FAKE_GIT_BRANCH'] = 'feat/x'
    const capture = await bb(['push', 'craftablesoftware/uq-api', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(gitLines()).toEqual(['rev-parse --abbrev-ref HEAD', 'push origin feat/x'])
  })
})

/* ------------------------------------------------------------------ *
 * Write gating
 * ------------------------------------------------------------------ */

describe('ops bb write gating', () => {
  const writes: Array<[string, string[]]> = [
    ['pipeline run', ['pipeline', 'run', '--repo', 'craftablesoftware/uq-api', '--branch', 'main', '--json']],
    ['pipeline stop', ['pipeline', 'stop', '--repo', 'craftablesoftware/uq-api', 'u1', '--json']],
    ['pr create', ['pr', 'create', '--repo', 'craftablesoftware/uq-api', '--title', 't', '--source', 'feat/x', '--json']],
    ['pr comment', ['pr', 'comment', '--repo', 'craftablesoftware/uq-api', '7', '--text', 'hi', '--json']],
    ['pr approve', ['pr', 'approve', '--repo', 'craftablesoftware/uq-api', '7', '--json']],
    ['pr decline', ['pr', 'decline', '--repo', 'craftablesoftware/uq-api', '7', '--json']],
    ['pr merge', ['pr', 'merge', '--repo', 'craftablesoftware/uq-api', '7', '--json']],
    ['branch create', ['branch', 'create', '--repo', 'craftablesoftware/uq-api', 'feature', '--from', 'main', '--json']],
    ['branch delete', ['branch', 'delete', '--repo', 'craftablesoftware/uq-api', 'feature', '--json']],
    ['commit', ['commit', 'craftablesoftware/uq-api', '-m', 'msg', '--json']],
    ['push', ['push', 'craftablesoftware/uq-api', '--branch', 'main', '--json']],
  ]

  test('every write refuses without --yes and records nothing', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    for (const [name, argv] of writes) {
      const capture = await bb(argv)
      expect({ name, code: capture.code }).toEqual({ name, code: 2 })
      expect({ name, kind: errorOf(capture)['kind'] }).toEqual({ name, kind: 'usage' })
      expect(server.requests.length).toBe(0)
      expect(gitLines()).toEqual([])
    }
  })

  test('--dry-run prints the request and stops', async () => {
    const server = startMockServer([])
    configure(server.url)
    const capture = await bb(['pr', 'comment', '--repo', 'craftablesoftware/uq-api', '7', '--text', 'hi', '--dry-run', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests.length).toBe(0)
    const data = dataOf(capture) as Record<string, unknown>
    expect((data['request'] as Record<string, unknown>)['method']).toBe('POST')
  })

  test('--dry-run for commit prints the command and runs no git', async () => {
    const server = startMockServer([])
    configure(server.url)
    makeClone()
    const capture = await bb(['commit', 'craftablesoftware/uq-api', '-m', 'msg', '--dry-run', '--json'])
    expect(capture.code).toBe(0)
    expect(gitLines()).toEqual([])
  })
})
describe('crafty bb pr create help', () => {
  test('shows selected nested help without loading config or contacting Bitbucket', async () => {
    const server = startMockServer([])
    process.env['OPS_CONFIG'] = join(scratch, 'missing-config.yml')
    const capture = await bb(['pr', 'create', '--help'])
    expect(capture.code).toBe(0)
    expect(server.requests).toEqual([])
  })
})

