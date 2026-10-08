import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jiraCommand from '../src/commands/jira.ts'
import { resetConfigCache } from '../src/targets.ts'
import { envelope, runCaptured, type CliCapture } from './helpers/cli.ts'
import { startMockServer, type MockServer, type MockRoute } from './helpers/mock-server.ts'

const scratch = mkdtempSync(join(tmpdir(), 'ops-jira-'))
let counter = 0

const AUTH = `Basic ${Buffer.from('ops:hunter2').toString('base64')}`

/** The operator's shell may carry the legacy token; put it back when done. */
const LEGACY_TOKEN = process.env['JIRA_API_TOKEN']

/** One Jira target pointed at the mock server, plus the credential in the env. */
function use(server: MockServer): void {
  counter += 1
  const path = join(scratch, `config-${counter}.yml`)
  writeFileSync(
    path,
    [
      'settings:',
      '  timeout_ms: 2000',
      '  max_rows: 200',
      'targets:',
      '  mock:',
      '    kind: jira',
      `    base_url: "${server.url}"`,
      '    auth: basic',
      '    username: ops',
      '    secret: mock',
      '',
    ].join('\n'),
  )
  process.env['OPS_CONFIG'] = path
  process.env['OPS_SECRET_MOCK'] = 'hunter2'
  resetConfigCache()
}

function errorOf(capture: CliCapture): Record<string, unknown> {
  return envelope(capture)['error'] as Record<string, unknown>
}

function bodyOf(request: { body: string }): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>
}

afterEach(() => {
  // Both are process-wide: leaving them set would reach every later test file.
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_MOCK']
  resetConfigCache()
})

beforeEach(() => {
  delete process.env['OPS_CONFIG']
  delete process.env['OPS_SECRET_MOCK']
  // The legacy Atlassian token wins over the store for the jira kind, and the
  // operator's shell may have one.
  delete process.env['JIRA_API_TOKEN']
  resetConfigCache()
})

afterAll(() => {
  resetConfigCache()
  if (LEGACY_TOKEN !== undefined) process.env['JIRA_API_TOKEN'] = LEGACY_TOKEN
  rmSync(scratch, { recursive: true, force: true })
})

describe('ops jira me', () => {
  test('reads /myself with the basic auth header', async () => {
    const server = startMockServer([
      {
        path: '/rest/api/3/myself',
        body: { accountId: '5b10a', displayName: 'Tiago', emailAddress: 't@x.test', active: true },
      },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['me', '--json'])
    expect(capture.code).toBe(0)
    expect(server.requests[0]!.method).toBe('GET')
    expect(server.requests[0]!.headers['authorization']).toBe(AUTH)
    const output = envelope(capture)
    expect(output['source']).toBe('jira')
    expect(output['target']).toBe('mock')
    expect(output['data']).toEqual({ accountId: '5b10a', displayName: 'Tiago', emailAddress: 't@x.test', active: true })
  })

  test('maps 401 to an auth failure', async () => {
    const server = startMockServer([
      { path: '/rest/api/3/myself', status: 401, body: { errorMessages: ['Client must be authenticated'] } },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['me', '--json'])
    expect(capture.code).toBe(3)
    expect(errorOf(capture)['kind']).toBe('auth')
    expect(errorOf(capture)['message']).toBe('Client must be authenticated')
  })
})

describe('ops jira issues', () => {
  test('paginates on nextPageToken until isLast', async () => {
    const server = startMockServer([
      {
        path: '/rest/api/3/search/jql',
        handler: (_request, seen) =>
          seen === 0
            ? { body: { isLast: false, nextPageToken: 'tok', issues: [{ key: 'A-1', id: '1', fields: { summary: 'one' } }] } }
            : { body: { isLast: true, issues: [{ key: 'A-2', id: '2', fields: { summary: 'two' } }] } },
      },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['issues', '--status', 'In Progress', '--json'])
    expect(capture.code).toBe(0)
    const posts = server.of('POST')
    expect(posts).toHaveLength(2)
    expect(bodyOf(posts[0]!)).toMatchObject({
      jql: 'assignee = currentUser() AND status = "In Progress"',
      maxResults: 50,
    })
    expect(bodyOf(posts[0]!)['nextPageToken']).toBeUndefined()
    expect(bodyOf(posts[1]!)['nextPageToken']).toBe('tok')

    const output = envelope(capture)
    expect((output['data'] as unknown[]).length).toBe(2)
    expect((output['meta'] as Record<string, unknown>)['truncated']).toBe(false)
  })

  test('--jql is sent verbatim', async () => {
    const server = startMockServer([
      { path: '/rest/api/3/search/jql', body: { isLast: true, issues: [] } },
    ])
    use(server)
    await runCaptured(jiraCommand, ['issues', '--jql', 'project = X', '--json'])
    expect(bodyOf(server.of('POST')[0]!)['jql']).toBe('project = X')
  })

  test('my work is the default query', async () => {
    const server = startMockServer([{ path: '/rest/api/3/search/jql', body: { isLast: true, issues: [] } }])
    use(server)
    await runCaptured(jiraCommand, ['issues', '--json'])
    expect(bodyOf(server.of('POST')[0]!)['jql']).toBe('assignee = currentUser()')
  })
})

describe('ops jira count', () => {
  test('posts the JQL to the approximate-count endpoint', async () => {
    const server = startMockServer([
      { path: '/rest/api/3/search/approximate-count', body: { count: 12 } },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['count', '--jql', 'project = A', '--json'])
    expect(capture.code).toBe(0)
    expect(bodyOf(server.of('POST')[0]!)).toEqual({ jql: 'project = A' })
    expect(envelope(capture)['data']).toEqual({ count: 12 })
  })
})

describe('ops jira sprouts and boards', () => {
  test('sprints sends the state list as one query parameter', async () => {
    const server = startMockServer([
      {
        path: '/rest/agile/1.0/board/7/sprint',
        body: { values: [{ id: 1, name: 'S1', state: 'active', startDate: '2026-01-01', endDate: '2026-01-14' }] },
      },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['sprints', '--board', '7', '--state', 'active,future', '--json'])
    expect(capture.code).toBe(0)
    const seen = new URLSearchParams(server.requests[0]!.query.replace(/^\?/, '')).get('state')
    expect(seen).toBe('active,future')
    expect((envelope(capture)['data'] as unknown[])[0]).toEqual({
      id: '1',
      name: 'S1',
      state: 'active',
      start: '2026-01-01',
      end: '2026-01-14',
    })
  })

  test('boards passes the project filter through', async () => {
    const server = startMockServer([
      {
        path: '/rest/agile/1.0/board',
        body: { values: [{ id: 3, name: 'Board', type: 'scrum', location: { projectKey: 'A' } }] },
      },
    ])
    use(server)
    await runCaptured(jiraCommand, ['boards', '--project', 'A', '--json'])
    expect(new URLSearchParams(server.requests[0]!.query.replace(/^\?/, '')).get('projectKeyOrId')).toBe('A')
  })
})

describe('ops jira issue', () => {
  test('flattens the description and reads comments', async () => {
    const server = startMockServer([
      {
        path: '/rest/api/3/issue/A-1',
        body: {
          key: 'A-1',
          id: '1',
          fields: {
            summary: 's',
            labels: ['l'],
            description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
          },
        },
      },
      {
        path: '/rest/api/3/issue/A-1/comment',
        body: {
          comments: [
            {
              id: 'c1',
              author: { displayName: 'Bob' },
              created: '2026-01-01',
              body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hey' }] }] },
            },
          ],
        },
      },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['issue', 'A-1', '--comments', '5', '--json'])
    expect(capture.code).toBe(0)
    const data = envelope(capture)['data'] as Record<string, unknown>
    expect(data['description']).toBe('desc')
    expect(data['labels']).toEqual(['l'])
    expect((data['comments'] as unknown[])[0]).toEqual({ id: 'c1', author: 'Bob', created: '2026-01-01', body: 'hey' })
  })
})

describe('ops jira comment', () => {
  test('sends the body as ADF and refuses without --yes', async () => {
    const server = startMockServer([
      { path: '/rest/api/3/issue/A-1/comment', body: { id: '10', created: '2026-01-01' } },
    ])
    use(server)
    const refused = await runCaptured(jiraCommand, ['comment', 'A-1', '--body', 'hi'])
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('re-run with --yes')
    expect(server.requests).toHaveLength(0)

    const capture = await runCaptured(jiraCommand, ['comment', 'A-1', '--body', 'one\n\ntwo', '--yes', '--json'])
    expect(capture.code).toBe(0)
    const posts = server.of('POST')
    expect(posts).toHaveLength(1)
    expect(bodyOf(posts[0]!)).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
        ],
      },
    })
    expect(envelope(capture)['data']).toEqual({ key: 'A-1', id: '10', created: '2026-01-01' })
  })

  test('--dry-run prints the resolved body and sends nothing', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1/comment', body: {} }])
    use(server)
    const capture = await runCaptured(jiraCommand, ['comment', 'A-1', '--body', 'hi', '--dry-run'])
    expect(capture.code).toBe(0)
    expect(server.requests).toHaveLength(0)
    expect(capture.stdout).toContain('dry-run')
  })

  test('--body-file reads the text from disk', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1/comment', body: { id: '11' } }])
    use(server)
    const path = join(scratch, 'comment.txt')
    writeFileSync(path, 'from a file')
    const capture = await runCaptured(jiraCommand, ['comment', 'A-1', '--body-file', path, '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(bodyOf(server.of('POST')[0]!)).toEqual({
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'from a file' }] }] },
    })
  })
})

describe('ops jira labels', () => {
  const routes: MockRoute[] = [
    { path: '/rest/api/3/issue/A-1', body: { fields: { labels: ['old', 'keep'] } } },
  ]

  test('read-modify-writes the whole labels field', async () => {
    const server = startMockServer(routes)
    use(server)
    const capture = await runCaptured(jiraCommand, [
      'labels',
      'A-1',
      '--add',
      'new,keep',
      '--remove',
      'old',
      '--yes',
      '--json',
    ])
    expect(capture.code).toBe(0)
    const puts = server.of('PUT')
    expect(puts).toHaveLength(1)
    expect(bodyOf(puts[0]!)).toEqual({ fields: { labels: ['keep', 'new'] } })
    expect(envelope(capture)['data']).toEqual({ key: 'A-1', labels: ['keep', 'new'] })
  })

  test('without --yes only the read happens', async () => {
    const server = startMockServer(routes)
    use(server)
    const capture = await runCaptured(jiraCommand, ['labels', 'A-1', '--add', 'x'])
    expect(capture.code).toBe(2)
    expect(server.of('PUT')).toHaveLength(0)
  })
})

describe('ops jira transition', () => {
  const transitions = {
    transitions: [
      { id: '31', name: 'Done', to: { name: 'Done' } },
      { id: '21', name: 'Start', to: { name: 'In Progress' } },
    ],
  }

  test('matches a status name case-insensitively', async () => {
    const server = startMockServer([
      { path: '/rest/api/3/issue/A-1/transitions', body: transitions },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['transition', 'A-1', 'in progress', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(bodyOf(server.of('POST')[0]!)).toEqual({ transition: { id: '21' } })
    expect(envelope(capture)['data']).toEqual({ key: 'A-1', transition: '21', to: 'In Progress' })
  })

  test('matches a transition id', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1/transitions', body: transitions }])
    use(server)
    await runCaptured(jiraCommand, ['transition', 'A-1', '31', '--yes'])
    expect(bodyOf(server.of('POST')[0]!)).toEqual({ transition: { id: '31' } })
  })

  test('an impossible transition is a not-found failure', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1/transitions', body: transitions }])
    use(server)
    const capture = await runCaptured(jiraCommand, ['transition', 'A-1', 'nope', '--yes', '--json'])
    expect(capture.code).toBe(1)
    expect(errorOf(capture)['kind']).toBe('not-found')
    expect(server.of('POST')).toHaveLength(0)
  })
})

describe('ops jira writes that need a read first', () => {
  test('assign me resolves through /myself', async () => {
    const server = startMockServer([
      { path: '/rest/api/3/myself', body: { accountId: 'me-1' } },
      { path: '/rest/api/3/issue/A-1/assignee', body: {} },
    ])
    use(server)
    const capture = await runCaptured(jiraCommand, ['assign', 'A-1', 'me', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(bodyOf(server.of('PUT')[0]!)).toEqual({ accountId: 'me-1' })
    expect(envelope(capture)['data']).toEqual({ key: 'A-1', accountId: 'me-1' })
  })

  test('assign none sends a null accountId', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1/assignee', body: {} }])
    use(server)
    await runCaptured(jiraCommand, ['assign', 'A-1', 'none', '--yes', '--json'])
    expect(bodyOf(server.of('PUT')[0]!)).toEqual({ accountId: null })
  })
})

describe('ops jira create and edit', () => {
  test('create assembles the fields object', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue', body: { key: 'A-9', id: '9' } }])
    use(server)
    const capture = await runCaptured(jiraCommand, [
      'create',
      '--project',
      'A',
      '--type',
      'Task',
      '--summary',
      'Do it',
      '--description',
      'one\n\ntwo',
      '--labels',
      'x,y',
      '--yes',
      '--json',
    ])
    expect(capture.code).toBe(0)
    expect(bodyOf(server.of('POST')[0]!)).toEqual({
      fields: {
        project: { key: 'A' },
        issuetype: { name: 'Task' },
        summary: 'Do it',
        description: {
          type: 'doc',
          version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
          ],
        },
        labels: ['x', 'y'],
      },
    })
    expect(envelope(capture)['data']).toEqual({ key: 'A-9', id: '9' })
  })

  test('edit gates before any request and sends only the given fields', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1', body: {} }])
    use(server)
    const refused = await runCaptured(jiraCommand, ['edit', 'A-1', '--summary', 'New'])
    expect(refused.code).toBe(2)
    expect(server.requests).toHaveLength(0)

    const capture = await runCaptured(jiraCommand, ['edit', 'A-1', '--summary', 'New', '--yes', '--json'])
    expect(capture.code).toBe(0)
    expect(bodyOf(server.of('PUT')[0]!)).toEqual({ fields: { summary: 'New' } })
  })

  test('edit without a field is a usage error', async () => {
    const server = startMockServer([{ path: '/rest/api/3/issue/A-1', body: {} }])
    use(server)
    const capture = await runCaptured(jiraCommand, ['edit', 'A-1', '--yes'])
    expect(capture.code).toBe(2)
    expect(server.requests).toHaveLength(0)
  })
})
