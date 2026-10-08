/**
 * `ops jira`: Jira Cloud REST v3 - boards, sprints, issues and the writes around
 * them. Reads are GETs (and the two search POSTs); every write goes through the
 * mutation gate before a byte leaves the machine.
 */
import { adfToText, textToAdf } from '../adf.ts'
import { errorMessage, OpsError, usageError } from '../errors.ts'
import { httpRequest, plannedRequest } from '../http.ts'
import type { HttpRequest } from '../http.ts'
import { emitResult, flag, gateMutation, intValue, listValue, option, required } from '../output.ts'
import type { Ctx } from '../output.ts'
import type { CommandModule, CommandNode } from '../command.ts'
import { loadConfig, requireTarget } from '../targets.ts'
import type { JiraTarget, Settings } from '../targets.ts'
import { isTable } from '../values.ts'

/* ------------------------------------------------------------------ *
 * The API's JSON, narrowed as it is read
 * ------------------------------------------------------------------ */

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function field(value: unknown, key: string): unknown {
  return isTable(value) ? value[key] : undefined
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  // Jira sends sprint ids as numbers and issue ids as strings.
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function nameOf(value: unknown): string {
  return text(field(value, 'name'))
}

/** Jira names a person by displayName, and answers with accountId elsewhere. */
function displayOf(value: unknown): string {
  return text(field(value, 'displayName')) || text(field(value, 'accountId')) || text(field(value, 'name'))
}

/* ------------------------------------------------------------------ *
 * Target, requests and shared pieces
 * ------------------------------------------------------------------ */

interface Api {
  target: JiraTarget
  settings: Settings
}

function jiraTarget(ctx: Ctx): Api {
  const target = requireTarget('jira', option(ctx.values, 'target'))
  if (target.kind !== 'jira') {
    throw new OpsError(`${target.name} is a ${target.kind} target, not a jira one`, 'config')
  }
  ctx.target = target.name
  return { target, settings: loadConfig().settings }
}

async function apiGet(api: Api, path: string, query?: HttpRequest['query']): Promise<unknown> {
  const response = await httpRequest(
    api.target,
    { method: 'GET', path, ...(query === undefined ? {} : { query }) },
    api.settings,
  )
  return response.json
}

async function apiPost(api: Api, path: string, body: unknown, retryable = false): Promise<unknown> {
  const response = await httpRequest(api.target, { method: 'POST', path, body, retryable }, api.settings)
  return response.json
}

async function apiPut(api: Api, path: string, body: unknown): Promise<unknown> {
  const response = await httpRequest(api.target, { method: 'PUT', path, body }, api.settings)
  return response.json
}

function issuePath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}`
}

function positional(ctx: Ctx, index: number, what: string, hint: string): string {
  const value = ctx.positionals[index]
  if (value === undefined || value === '') throw usageError(`${what} is required`, hint)
  return value
}

function issueKey(ctx: Ctx): string {
  return positional(ctx, 0, 'an issue key', 'as in `crafty jira issue PROJ-123`')
}

/** The `--body`/`--body-file` pair, read as the one string Jira wants. */
async function bodyOption(ctx: Ctx): Promise<string> {
  const inline = option(ctx.values, 'body')
  const file = option(ctx.values, 'body-file')
  const hasInline = inline !== undefined && inline !== ''
  const hasFile = file !== undefined && file !== ''
  if (hasInline === hasFile) {
    throw usageError(
      hasInline ? 'give --body or --body-file, not both' : 'one of --body or --body-file is required',
    )
  }
  if (hasFile) return await readTextFile(file!)
  return inline!
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  } catch (error) {
    throw usageError(`cannot read ${path}: ${errorMessage(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

const ISSUE_COLUMNS = ['key', 'type', 'status', 'assignee', 'priority', 'summary', 'updated']
const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated', 'labels']

function issueRow(raw: unknown): Record<string, unknown> {
  const fields = field(raw, 'fields')
  return {
    key: text(field(raw, 'key')),
    type: nameOf(field(fields, 'issuetype')),
    status: nameOf(field(fields, 'status')),
    assignee: displayOf(field(fields, 'assignee')),
    priority: nameOf(field(fields, 'priority')),
    summary: text(field(fields, 'summary')),
    updated: text(field(fields, 'updated')),
  }
}

function sprintRow(raw: unknown): Record<string, unknown> {
  return {
    id: text(field(raw, 'id')),
    name: text(field(raw, 'name')),
    state: text(field(raw, 'state')),
    start: text(field(raw, 'startDate')),
    end: text(field(raw, 'endDate')),
  }
}

/* ------------------------------------------------------------------ *
 * JQL composition and issue paging
 * ------------------------------------------------------------------ */

/**
 * With no `--jql`, the window is the current user's work plus whatever filters
 * were given - the question `ops jira issues` is usually asking.
 */
function jqlFrom(ctx: Ctx): string {
  const explicit = option(ctx.values, 'jql')
  if (explicit !== undefined && explicit !== '') return explicit

  const clauses: string[] = []
  const assignee = option(ctx.values, 'assignee')
  if (assignee === undefined || assignee === '' || assignee === 'me') clauses.push('assignee = currentUser()')
  else clauses.push(`assignee = "${assignee}"`)

  const status = option(ctx.values, 'status')
  if (status !== undefined && status !== '') clauses.push(`status = "${status}"`)
  const project = option(ctx.values, 'project')
  if (project !== undefined && project !== '') clauses.push(`project = "${project}"`)
  const board = option(ctx.values, 'board')
  if (board !== undefined && board !== '') clauses.push(`board = ${board}`)
  const sprint = option(ctx.values, 'sprint')
  if (sprint !== undefined && sprint !== '') clauses.push(`sprint = ${sprint}`)
  return clauses.join(' AND ')
}

/**
 * `/rest/api/3/search/jql` pages on `nextPageToken` until `isLast`. The page cap
 * is the client's, never a rewrite of the query.
 */
async function searchIssues(api: Api, jql: string, wanted: number): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const collected: unknown[] = []
  let token: string | undefined
  let last = false
  while (!last && collected.length < wanted) {
    const body: Record<string, unknown> = {
      jql,
      fields: ISSUE_FIELDS,
      maxResults: Math.max(Math.min(100, wanted - collected.length), 1),
    }
    if (token !== undefined) body['nextPageToken'] = token
    const answered = await apiPost(api, '/rest/api/3/search/jql', body, true)
    collected.push(...asList(field(answered, 'issues')))
    const next = field(answered, 'nextPageToken')
    token = typeof next === 'string' ? next : undefined
    last = field(answered, 'isLast') === true || token === undefined
  }
  const rows = collected.slice(0, wanted).map(issueRow)
  return { rows, truncated: collected.length > rows.length || !last }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

const meVerb: CommandNode = { summary: 'The account the stored token belongs to',
usage: [
  'crafty jira me [options]',
  '',
  'GET /rest/api/3/myself: the authenticated account as Jira sees it, which is',
  'the quickest way to prove a token still works.',
  '',
  'Options:',
  '  --target <name>  Jira target to use (default settings.default_targets.jira)',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const myself = await apiGet(api, '/rest/api/3/myself')
  emitResult(
    ctx,
    {
      accountId: text(field(myself, 'accountId')),
      displayName: text(field(myself, 'displayName')),
      emailAddress: text(field(myself, 'emailAddress')),
      active: field(myself, 'active') === true,
    },
    { truncated: false },
  )
  return 0
}, }

const boardsVerb: CommandNode = { summary: 'Boards the token can read',
usage: [
  'crafty jira boards [--project KEY] [options]',
  '',
  'GET /rest/agile/1.0/board. --project sends projectKeyOrId, so one project is',
  'listed instead of every board on the site.',
  '',
  'Options:',
  '  --project <key>  Restrict the list to one project',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [{ name: 'project', type: 'string' }],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const project = option(ctx.values, 'project')
  const answered = await apiGet(api, '/rest/agile/1.0/board', project === undefined ? undefined : { projectKeyOrId: project })
  const rows = asList(field(answered, 'values')).map((board) => ({
    id: text(field(board, 'id')),
    name: text(field(board, 'name')),
    type: text(field(board, 'type')),
    project: text(field(field(board, 'location'), 'projectKey')),
  }))
  emitResult(ctx, rows, { columns: ['id', 'name', 'type', 'project'], truncated: false })
  return 0
}, }

async function emitSprints(ctx: Ctx, api: Api, boardId: string, state: string[]): Promise<number> {
  const answered = await apiGet(
    api,
    `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`,
    state.length === 0 ? undefined : { state: state.join(',') },
  )
  const rows = asList(field(answered, 'values')).map(sprintRow)
  emitResult(ctx, rows, { columns: ['id', 'name', 'state', 'start', 'end'], truncated: false })
  return 0
}

const boardVerb: CommandNode = { summary: 'The issues on a board, or its sprints',
usage: [
  'crafty jira board <id> [--sprints] [options]',
  '',
  'GET /rest/agile/1.0/board/{id}/issue, or /sprint with --sprints. The board id',
'is the one `crafty jira boards` prints.',
  '',
  'Options:',
  '  --sprints        List the board\u2019s sprints instead of its issues',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [{ name: 'sprints', type: 'boolean' }],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const id = positional(ctx, 0, 'a board id', 'as in `crafty jira board 42`, see `crafty jira boards`')
  if (flag(ctx.values, 'sprints')) return await emitSprints(ctx, api, id, [])
  const answered = await apiGet(api, `/rest/agile/1.0/board/${encodeURIComponent(id)}/issue`, { maxResults: 50 })
  emitResult(ctx, asList(field(answered, 'issues')).map(issueRow), { columns: ISSUE_COLUMNS, truncated: false })
  return 0
}, }

const sprintsVerb: CommandNode = { summary: 'Sprints of one board',
usage: [
  'crafty jira sprints --board <id> [--state active,future,closed] [options]',
  '',
  'GET /rest/agile/1.0/board/{id}/sprint. --state is a comma-separated list, so',
  '`--state active,future` is the usual call for planning.',
  '',
  'Options:',
  '  --board <id>     Board whose sprints to list (required)',
  '  --state <list>   active, future, closed (comma-separated)',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [
  { name: 'board', type: 'string' },
  { name: 'state', type: 'string' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  return await emitSprints(ctx, api, required(ctx, 'board', '--board'), listValue(ctx, 'state'))
}, }

const issuesVerb: CommandNode = { summary: 'Search issues by JQL or by filters',
usage: [
  'crafty jira issues [--jql Q] [--board id] [--sprint id] [--assignee me|<accountId>]',
  '                [--status S] [--project K] [--limit N] [--all] [options]',
  '',
  'POST /rest/api/3/search/jql, paging on nextPageToken until Jira says the',
  'last page is done. Without --jql the query is `assignee = currentUser()`',
'plus the filters given, so a bare `crafty jira issues` is "my work".',
  '',
  'Options:',
  '  --jql <query>       Use this JQL verbatim; the filters below are ignored',
  '  --board <id>        board = <id>',
  '  --sprint <id>       sprint = <id>',
  '  --assignee <who>    me (the default) or an accountId',
  '  --status <name>     status = "<name>"',
  '  --project <key>     project = "<key>"',
  '  --limit <n>         Rows to fetch (default 50, cap settings.max_rows)',
  '  --all               Fetch up to settings.max_rows rows',
  '  --target <name>     Jira target to use',
  '  --json              Print the envelope',
  '  -h, --help          Show this message',
],
options: [
  { name: 'jql', type: 'string' },
  { name: 'board', type: 'string' },
  { name: 'sprint', type: 'string' },
  { name: 'assignee', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'project', type: 'string' },
  { name: 'limit', type: 'string' },
  { name: 'all', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const requested = flag(ctx.values, 'all') ? api.settings.max_rows : intValue(ctx, 'limit', 50, 1, 10_000)
  const { rows, truncated } = await searchIssues(api, jqlFrom(ctx), Math.min(requested, api.settings.max_rows))
  emitResult(ctx, rows, { columns: ISSUE_COLUMNS, truncated })
  return 0
}, }

const countVerb: CommandNode = { summary: 'How many issues a query matches',
usage: [
  'crafty jira count [--jql Q] [options]',
  '',
  'POST /rest/api/3/search/approximate-count. Cheaper than `issues` because',
  'Jira counts instead of returning the rows.',
  '',
  'Options:',
  '  --jql <query>    Use this JQL verbatim',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [{ name: 'jql', type: 'string' }],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const answered = await apiPost(api, '/rest/api/3/search/approximate-count', { jql: jqlFrom(ctx) }, true)
  emitResult(ctx, { count: field(answered, 'count') ?? 0 }, { truncated: false })
  return 0
}, }

const issueVerb: CommandNode = { summary: 'One issue, optionally with its comments',
usage: [
  'crafty jira issue <KEY> [--comments N] [options]',
  '',
  'GET /rest/api/3/issue/{key}. The description comes back as text, so the ADF',
  'Jira stores is readable without a browser.',
  '',
  'Options:',
  '  --comments <n>   Include the last n comments (default 20 when given)',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [{ name: 'comments', type: 'string' }],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const answered = await apiGet(api, issuePath(key))
  const fields = field(answered, 'fields')
  const data: Record<string, unknown> = {
    key: text(field(answered, 'key')) || key,
    id: text(field(answered, 'id')),
    summary: text(field(fields, 'summary')),
    type: nameOf(field(fields, 'issuetype')),
    status: nameOf(field(fields, 'status')),
    assignee: displayOf(field(fields, 'assignee')),
    reporter: displayOf(field(fields, 'reporter')),
    priority: nameOf(field(fields, 'priority')),
    labels: asList(field(fields, 'labels')).map((label) => text(label)),
    description: adfToText(field(fields, 'description')),
    updated: text(field(fields, 'updated')),
  }
  if (option(ctx.values, 'comments') !== undefined) {
    const limit = intValue(ctx, 'comments', 20, 1, 1_000)
    const answered = await apiGet(api, `${issuePath(key)}/comment`, { maxResults: limit })
    data['comments'] = asList(field(answered, 'comments')).slice(0, limit).map((comment) => ({
      id: text(field(comment, 'id')),
      author: displayOf(field(comment, 'author')),
      created: text(field(comment, 'created')),
      body: adfToText(field(comment, 'body')),
    }))
  }
  emitResult(ctx, data, { truncated: false })
  return 0
}, }

const transitionsVerb: CommandNode = { summary: 'The transitions an issue can make right now',
usage: [
  'crafty jira transitions <KEY> [options]',
  '',
  'GET /rest/api/3/issue/{key}/transitions. The `to` column is the status each',
'transition lands on - what `crafty jira transition <KEY> <status>` matches.',
  '',
  'Options:',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const answered = await apiGet(api, `${issuePath(key)}/transitions`)
  const rows = asList(field(answered, 'transitions')).map((transition) => ({
    id: text(field(transition, 'id')),
    name: text(field(transition, 'name')),
    to: nameOf(field(transition, 'to')),
  }))
  emitResult(ctx, rows, { columns: ['id', 'name', 'to'], truncated: false })
  return 0
}, }

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

const commentVerb: CommandNode = { summary: 'Add a comment to an issue',
usage: [
  'crafty jira comment <KEY> (--body TEXT | --body-file PATH) [options]',
  '',
  'POST /rest/api/3/issue/{key}/comment. The body is converted to ADF, with',
  'blank lines separating paragraphs. Requires --yes.',
  '',
  'Options:',
  '  --body <text>      Comment text',
  '  --body-file <path> Read the comment from a file instead',
  '  --yes              Confirm the write',
  '  --dry-run          Print the request and stop',
  '  --target <name>    Jira target to use',
  '  --json             Print the envelope',
  '  -h, --help         Show this message',
],
options: [
  { name: 'body', type: 'string' },
  { name: 'body-file', type: 'string' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const request: HttpRequest = {
    method: 'POST',
    path: `${issuePath(key)}/comment`,
    body: { body: textToAdf(await bodyOption(ctx)) },
  }
  if (gateMutation(ctx, `comment on ${key}`, plannedRequest(api.target, request)) === 'stop') return 0
  const answered = await apiPost(api, request.path, request.body)
  emitResult(ctx, { key, id: text(field(answered, 'id')), created: text(field(answered, 'created')) }, { truncated: false })
  return 0
}, }

const assignVerb: CommandNode = { summary: 'Set or clear an issue\u2019s assignee',
usage: [
  'crafty jira assign <KEY> (me | none | <accountId>) [options]',
  '',
  'PUT /rest/api/3/issue/{key}/assignee. `me` resolves through /myself; `none`',
  'sends a null assignee, which unassigns the issue. Requires --yes.',
  '',
  'Options:',
  '  --yes            Confirm the write',
  '  --dry-run        Print the request and stop',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const who = positional(ctx, 1, 'an assignee', 'me, none, or an accountId from `crafty jira issues --json`')
  const accountId = who === 'none' ? null : who === 'me' ? text(field(await apiGet(api, '/rest/api/3/myself'), 'accountId')) : who
  const request: HttpRequest = { method: 'PUT', path: `${issuePath(key)}/assignee`, body: { accountId } }
  if (gateMutation(ctx, `assign ${key}`, plannedRequest(api.target, request)) === 'stop') return 0
  await apiPut(api, request.path, request.body)
  emitResult(ctx, { key, accountId }, { truncated: false })
  return 0
}, }

const labelsVerb: CommandNode = { summary: 'Add or remove labels on an issue',
usage: [
  'crafty jira labels <KEY> [--add a,b] [--remove c] [options]',
  '',
  'Jira replaces the whole labels field, so this reads the issue\u2019s current',
  'labels and writes the result of the add/remove back. Requires --yes.',
  '',
  'Options:',
  '  --add <list>     Labels to add (comma-separated)',
  '  --remove <list>  Labels to remove (comma-separated)',
  '  --yes            Confirm the write',
  '  --dry-run        Print the request and stop',
  '  --target <name>  Jira target to use',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
options: [
  { name: 'add', type: 'string' },
  { name: 'remove', type: 'string' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const add = listValue(ctx, 'add')
  const remove = listValue(ctx, 'remove')
  if (add.length === 0 && remove.length === 0) throw usageError('one of --add or --remove is required')

  const answered = await apiGet(api, issuePath(key), { fields: 'labels' })
  const removed = new Set(remove)
  const labels = asList(field(field(answered, 'fields'), 'labels'))
    .map((label) => text(label))
    .filter((label) => !removed.has(label))
  for (const label of add) if (!labels.includes(label)) labels.push(label)

  const request: HttpRequest = { method: 'PUT', path: issuePath(key), body: { fields: { labels } } }
  if (gateMutation(ctx, `set labels on ${key}`, plannedRequest(api.target, request)) === 'stop') return 0
  await apiPut(api, request.path, request.body)
  emitResult(ctx, { key, labels }, { truncated: false })
  return 0
}, }

const transitionVerb: CommandNode = { summary: 'Move an issue to another status',
usage: [
  'crafty jira transition <KEY> <status|id> [--comment TEXT] [options]',
  '',
  'Reads the issue\u2019s transitions and matches <status|id> against a transition\u2019s',
  'id or the status it lands on (case-insensitive), then POSTs it. Requires --yes.',
  '',
  'Options:',
  '  --comment <text>  Add this comment as part of the transition',
  '  --yes             Confirm the write',
  '  --dry-run         Print the request and stop',
  '  --target <name>   Jira target to use',
  '  --json            Print the envelope',
  '  -h, --help        Show this message',
],
options: [
  { name: 'comment', type: 'string' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const wanted = positional(ctx, 1, 'a target status or transition id', 'see `crafty jira transitions <KEY>`')
  const answered = await apiGet(api, `${issuePath(key)}/transitions`)
  const transitions = asList(field(answered, 'transitions'))
  const match = transitions.find(
    (transition) =>
      text(field(transition, 'id')) === wanted || nameOf(field(transition, 'to')).toLowerCase() === wanted.toLowerCase(),
  )
  if (match === undefined) {
    throw new OpsError(`no transition from ${key} matches "${wanted}"`, 'not-found', {
      hint: `available: ${transitions.map((transition) => `${nameOf(field(transition, 'to'))} (${text(field(transition, 'id'))})`).join(', ')}`,
    })
  }
  const id = text(field(match, 'id'))
  const to = nameOf(field(match, 'to'))
  const body: Record<string, unknown> = { transition: { id } }
  const comment = option(ctx.values, 'comment')
  if (comment !== undefined && comment !== '') body['update'] = { comment: [{ add: { body: textToAdf(comment) } }] }

  const request: HttpRequest = { method: 'POST', path: `${issuePath(key)}/transitions`, body }
  if (gateMutation(ctx, `transition ${key} to ${to}`, plannedRequest(api.target, request)) === 'stop') return 0
  await apiPost(api, request.path, request.body)
  emitResult(ctx, { key, transition: id, to }, { truncated: false })
  return 0
}, }

const createVerb: CommandNode = { summary: 'Create an issue',
usage: [
  'crafty jira create --project K --type T --summary S [options]',
  '',
  'POST /rest/api/3/issue. The description is converted to ADF. Requires --yes.',
  '',
  'Options:',
  '  --project <key>     Project key (required)',
  '  --type <name>       Issue type, such as Task or Bug (required)',
  '  --summary <text>    Issue summary (required)',
  '  --description <text>  Description, blank lines separating paragraphs',
  '  --assignee <who>    me or an accountId',
  '  --labels <list>     Labels to set (comma-separated)',
  '  --yes               Confirm the write',
  '  --dry-run           Print the request and stop',
  '  --target <name>     Jira target to use',
  '  --json              Print the envelope',
  '  -h, --help          Show this message',
],
options: [
  { name: 'project', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'assignee', type: 'string' },
  { name: 'labels', type: 'string' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const fields: Record<string, unknown> = {
    project: { key: required(ctx, 'project', '--project') },
    issuetype: { name: required(ctx, 'type', '--type') },
    summary: required(ctx, 'summary', '--summary'),
  }
  const description = option(ctx.values, 'description')
  if (description !== undefined && description !== '') fields['description'] = textToAdf(description)
  const assignee = option(ctx.values, 'assignee')
  if (assignee !== undefined && assignee !== '') {
    const accountId = assignee === 'me' ? text(field(await apiGet(api, '/rest/api/3/myself'), 'accountId')) : assignee
    fields['assignee'] = { accountId }
  }
  const labels = listValue(ctx, 'labels')
  if (labels.length > 0) fields['labels'] = labels

  const request: HttpRequest = { method: 'POST', path: '/rest/api/3/issue', body: { fields } }
  if (gateMutation(ctx, 'create an issue', plannedRequest(api.target, request)) === 'stop') return 0
  const answered = await apiPost(api, request.path, request.body)
  emitResult(ctx, { key: text(field(answered, 'key')), id: text(field(answered, 'id')) }, { truncated: false })
  return 0
}, }

const editVerb: CommandNode = { summary: 'Edit an issue\u2019s summary or description',
usage: [
  'crafty jira edit <KEY> [--summary S] [--description T] [options]',
  '',
  'PUT /rest/api/3/issue/{key}. Only the fields given are sent. Requires --yes.',
  '',
  'Options:',
  '  --summary <text>      New summary',
  '  --description <text>  New description (replaces the whole field)',
  '  --yes                 Confirm the write',
  '  --dry-run             Print the request and stop',
  '  --target <name>       Jira target to use',
  '  --json                Print the envelope',
  '  -h, --help            Show this message',
],
options: [
  { name: 'summary', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
],
run: async (ctx) => {
  const api = jiraTarget(ctx)
  const key = issueKey(ctx)
  const fields: Record<string, unknown> = {}
  const summary = option(ctx.values, 'summary')
  if (summary !== undefined && summary !== '') fields['summary'] = summary
  const description = option(ctx.values, 'description')
  if (description !== undefined && description !== '') fields['description'] = textToAdf(description)
  if (Object.keys(fields).length === 0) throw usageError('one of --summary or --description is required')

  const request: HttpRequest = { method: 'PUT', path: issuePath(key), body: { fields } }
  if (gateMutation(ctx, `edit ${key}`, plannedRequest(api.target, request)) === 'stop') return 0
  await apiPut(api, request.path, request.body)
  emitResult(ctx, { key }, { truncated: false })
  return 0
}, }

export default {
  name: 'jira',
  summary: 'Jira Cloud: boards, sprints, issues, transitions and writes',
  source: 'jira',
  options: [{ name: 'target', type: 'string' }],
  commands: {
    me: meVerb,
    boards: boardsVerb,
    board: boardVerb,
    sprints: sprintsVerb,
    issues: issuesVerb,
    count: countVerb,
    issue: issueVerb,
    transitions: transitionsVerb,
    comment: commentVerb,
    assign: assignVerb,
    labels: labelsVerb,
    transition: transitionVerb,
    create: createVerb,
    edit: editVerb,
  },
} satisfies CommandModule
