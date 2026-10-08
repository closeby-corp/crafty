/**
 * `crafty bb`: Bitbucket Cloud REST 2.0 - repositories, pipelines, pull requests
 * and branches - plus the local-clone verbs that drive git. Every write goes
 * through the `--yes` gate before anything reaches the network or the remote.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { exec } from '../lib/exec.ts'
import { httpRequest, plannedRequest } from '../lib/http.ts'
import type { HttpRequest } from '../lib/http.ts'
import { asOpsError, OpsError, usageError } from 'crafty'
import type { OptionSpec } from 'crafty'
import {
  emitResult,
  flag,
  intValue,
  listValue,
  option,
  required,
  write,
  gateMutation,
} from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { expandHome, loadConfig, requireTarget } from '../lib/targets.ts'
import type { BitbucketTarget, Settings } from '../lib/targets.ts'
import { isTable } from '../lib/values.ts'

interface RepoRef {
  workspace: string
  repo: string
}

/* ------------------------------------------------------------------ *
 * Target and repository resolution
 * ------------------------------------------------------------------ */

/** The one bitbucket target, named explicitly on the command line. */
function bitbucketTarget(ctx: Ctx): BitbucketTarget {
  const target = requireTarget('bitbucket')
  if (target.kind !== 'bitbucket') {
    throw new OpsError(`target "${target.name}" is not a bitbucket target`, 'config')
  }
  ctx.target = target.name
  return target
}

/**
 * `<workspace>/<slug>`, or a bare slug against the target's workspace. The hint
 * only offers the spellings the calling verb actually accepts: a write verb's
 * positional slot already holds a branch, a uuid or a pull-request id.
 */
function repoArg(value: string | undefined, target: BitbucketTarget, alsoPositional = false): RepoRef {
  if (value === undefined || value === '') {
    throw usageError(
      'a repository is required',
      alsoPositional
        ? 'pass <workspace>/<repo> or --repo <workspace>/<repo>; a bare slug uses the target workspace'
        : 'pass --repo <workspace>/<repo>; a bare slug uses the target workspace',
    )
  }
  const slash = value.indexOf('/')
  if (slash === -1) return { workspace: target.workspace, repo: value }
  const workspace = value.slice(0, slash)
  const repo = value.slice(slash + 1)
  if (workspace === '' || repo === '') throw usageError(`"${value}" is not <workspace>/<repo>`)
  return { workspace, repo }
}

function repoOption(ctx: Ctx, target: BitbucketTarget): RepoRef {
  return repoArg(option(ctx.values, 'repo'), target)
}

/**
 * `--repo` or the positional, for the verbs that take no other positional: the
 * hint they print has always advertised both spellings.
 */
function repoOptionOrPositional(ctx: Ctx, target: BitbucketTarget): RepoRef {
  return repoArg(option(ctx.values, 'repo') ?? ctx.positionals[0], target, true)
}

/**
 * A clone is the one git call long enough to deserve its own bound; everything
 * else uses the git budget from settings.
 */
function gitTimeoutMs(ctx: Ctx, settings: Settings): number {
  const raw = option(ctx.values, 'timeout')
  if (raw === undefined) return settings.git_timeout_ms
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageError('--timeout must be a positive number of seconds')
  return Math.round(seconds * 1_000)
}

function repoPath(ref: RepoRef): string {
  return `repositories/${ref.workspace}/${ref.repo}`
}

function positional(ctx: Ctx, what: string, hint?: string): string {
  const value = ctx.positionals[0]
  if (value === undefined) throw usageError(`${what} is required`, hint)
  return value
}

/* ------------------------------------------------------------------ *
 * Paging and row shaping
 * ------------------------------------------------------------------ */

function tables(values: unknown[]): Record<string, unknown>[] {
  return values.filter((value): value is Record<string, unknown> => isTable(value))
}

function pageValues(json: unknown): { values: unknown[]; next: string | undefined } {
  const table = isTable(json) ? json : {}
  return {
    values: Array.isArray(table['values']) ? table['values'] : [],
    next: typeof table['next'] === 'string' ? table['next'] : undefined,
  }
}

/** Bitbucket paginates with an absolute `next`, which has to come back as a path. */
function relativePath(target: BitbucketTarget, url: string): string {
  const base = target.base_url.replace(/\/+$/, '')
  if (!url.startsWith(`${base}/`)) throw new OpsError(`the API pointed outside ${base}: ${url}`, 'upstream')
  return url.slice(base.length + 1)
}

/**
 * Collects one page, and (with `all`) every `next` after it. `incomplete`
 * reports that pages were left unread, so the caller can mark the result
 * truncated.
 */
async function collect(
  target: BitbucketTarget,
  settings: Settings,
  request: HttpRequest,
  all: boolean,
): Promise<{ values: unknown[]; incomplete: boolean }> {
  const first = await httpRequest(target, request, settings)
  const values: unknown[] = []
  let page = pageValues(first.json)
  values.push(...page.values)
  let next = page.next
  while (all && next !== undefined) {
    const response = await httpRequest(target, { method: 'GET', path: relativePath(target, next) }, settings)
    page = pageValues(response.json)
    values.push(...page.values)
    next = page.next
  }
  return { values, incomplete: next !== undefined }
}

/** Caps a row set at `settings.max_rows` and reports whether it was cut. */
function emitRows(
  ctx: Ctx,
  rows: Record<string, unknown>[],
  columns: string[],
  settings: Settings,
  incomplete: boolean,
): number {
  const truncated = incomplete || rows.length > settings.max_rows
  emitResult(ctx, rows.slice(0, settings.max_rows), { columns, truncated })
  return 0
}

function repoRow(entry: Record<string, unknown>): Record<string, unknown> {
  const workspace = isTable(entry['workspace']) ? entry['workspace'] : {}
  return {
    workspace: typeof workspace['slug'] === 'string' ? workspace['slug'] : '',
    slug: typeof entry['slug'] === 'string' ? entry['slug'] : '',
    name: typeof entry['name'] === 'string' ? entry['name'] : '',
    private: entry['is_private'] === true,
    updated_on: typeof entry['updated_on'] === 'string' ? entry['updated_on'] : null,
  }
}

function repoDetail(entry: Record<string, unknown>, ref: RepoRef): Record<string, unknown> {
  const mainbranch = isTable(entry['mainbranch']) ? entry['mainbranch'] : {}
  return {
    ...repoRow({ ...entry, workspace: { slug: ref.workspace }, slug: entry['slug'] ?? ref.repo }),
    description: typeof entry['description'] === 'string' ? entry['description'] : '',
    language: typeof entry['language'] === 'string' ? entry['language'] : '',
    size: typeof entry['size'] === 'number' ? entry['size'] : null,
    mainbranch: typeof mainbranch['name'] === 'string' ? mainbranch['name'] : '',
    created_on: typeof entry['created_on'] === 'string' ? entry['created_on'] : null,
  }
}

function pipelineRow(entry: Record<string, unknown>): Record<string, unknown> {
  const state = isTable(entry['state']) ? entry['state'] : {}
  const result = isTable(state['result']) ? state['result'] : {}
  const target = isTable(entry['target']) ? entry['target'] : {}
  return {
    uuid: typeof entry['uuid'] === 'string' ? entry['uuid'] : '',
    build_number: typeof entry['build_number'] === 'number' ? entry['build_number'] : null,
    state: typeof state['name'] === 'string' ? state['name'] : '',
    result: typeof result['name'] === 'string' ? result['name'] : '',
    branch: typeof target['ref_name'] === 'string' ? target['ref_name'] : '',
    created_on: typeof entry['created_on'] === 'string' ? entry['created_on'] : null,
    duration_s: typeof entry['duration_in_seconds'] === 'number' ? entry['duration_in_seconds'] : null,
  }
}

function stepRow(entry: Record<string, unknown>): Record<string, unknown> {
  const state = isTable(entry['state']) ? entry['state'] : {}
  const result = isTable(state['result']) ? state['result'] : {}
  return {
    uuid: typeof entry['uuid'] === 'string' ? entry['uuid'] : '',
    name: typeof entry['name'] === 'string' ? entry['name'] : '',
    state: typeof state['name'] === 'string' ? state['name'] : '',
    result: typeof result['name'] === 'string' ? result['name'] : '',
    duration_s: typeof entry['duration_in_seconds'] === 'number' ? entry['duration_in_seconds'] : null,
  }
}

function prRow(entry: Record<string, unknown>): Record<string, unknown> {
  const source = isTable(entry['source']) ? entry['source'] : {}
  const sourceBranch = isTable(source['branch']) ? source['branch'] : {}
  const destination = isTable(entry['destination']) ? entry['destination'] : {}
  const destinationBranch = isTable(destination['branch']) ? destination['branch'] : {}
  const author = isTable(entry['author']) ? entry['author'] : {}
  return {
    id: typeof entry['id'] === 'number' ? entry['id'] : null,
    title: typeof entry['title'] === 'string' ? entry['title'] : '',
    state: typeof entry['state'] === 'string' ? entry['state'] : '',
    source: typeof sourceBranch['name'] === 'string' ? sourceBranch['name'] : '',
    destination: typeof destinationBranch['name'] === 'string' ? destinationBranch['name'] : '',
    author: typeof author['display_name'] === 'string' ? author['display_name'] : '',
    updated_on: typeof entry['updated_on'] === 'string' ? entry['updated_on'] : null,
  }
}

function commentRow(entry: Record<string, unknown>): Record<string, unknown> {
  const author = isTable(entry['author']) ? entry['author'] : {}
  const content = isTable(entry['content']) ? entry['content'] : {}
  return {
    id: typeof entry['id'] === 'number' ? entry['id'] : null,
    author: typeof author['display_name'] === 'string' ? author['display_name'] : '',
    body: typeof content['raw'] === 'string' ? content['raw'] : '',
    created_on: typeof entry['created_on'] === 'string' ? entry['created_on'] : null,
  }
}

function branchRow(entry: Record<string, unknown>): Record<string, unknown> {
  const target = isTable(entry['target']) ? entry['target'] : {}
  return {
    name: typeof entry['name'] === 'string' ? entry['name'] : '',
    hash: typeof target['hash'] === 'string' ? target['hash'] : '',
    date: typeof target['date'] === 'string' ? target['date'] : null,
  }
}

const REPO_COLUMNS = ['workspace', 'slug', 'name', 'private', 'updated_on']
const PIPELINE_COLUMNS = ['uuid', 'build_number', 'state', 'result', 'branch', 'created_on', 'duration_s']
const STEP_COLUMNS = ['uuid', 'name', 'state', 'result', 'duration_s']
const PR_COLUMNS = ['id', 'title', 'state', 'source', 'destination', 'author', 'updated_on']
const BRANCH_COLUMNS = ['name', 'hash', 'date']

/* ------------------------------------------------------------------ *
 * Local clone helpers
 * ------------------------------------------------------------------ */

function requireClone(settings: Settings, ref: RepoRef): string {
  const dir = join(expandHome(settings.data_dir), 'repos', ref.workspace, ref.repo)
  if (!existsSync(dir)) {
    throw new OpsError(`no local clone at ${dir}`, 'config', {
      hint: `run \`crafty bb repo clone ${ref.workspace}/${ref.repo}\``,
    })
  }
  return dir
}

/** `--author "Name <email>"`, else settings.git_author, else git's own config. */
function gitIdentity(settings: Settings, override: string | undefined): string[] {
  const author = override ?? settings.git_author
  if (author === undefined || author === '') return []
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(author)
  if (match === null) return ['-c', `user.name=${author.trim()}`]
  const name = match[1]!.trim()
  const email = match[2]!.trim()
  return [
    ...(name === '' ? [] : ['-c', `user.name=${name}`]),
    ...(email === '' ? [] : ['-c', `user.email=${email}`]),
  ]
}

/** The porcelain `-b` header, split into branch, upstream and ahead/behind. */
function parseStatus(text: string, repo: string): Record<string, unknown> {
  const lines = text.split('\n').filter((line) => line !== '')
  const header = lines.length > 0 && lines[0]!.startsWith('## ') ? lines.shift()!.slice(3) : ''
  const names = (header.split(' ')[0] ?? '').split('...')
  const ahead = /ahead (\d+)/.exec(header)
  const behind = /behind (\d+)/.exec(header)
  return {
    repo,
    branch: names[0] ?? '',
    upstream: names[1] ?? '',
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    clean: lines.length === 0,
    changes: lines,
  }
}


/* ------------------------------------------------------------------ *
 * `bb repo`
 * ------------------------------------------------------------------ */

const repoListVerb: CommandNode = { summary: 'Repositories in the workspace',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const limit = intValue(ctx, 'limit', Math.min(settings.max_rows, 100), 1, 100)
  const query = option(ctx.values, 'query')
  const request: HttpRequest = {
    method: 'GET',
    path: `repositories/${target.workspace}`,
    query: { pagelen: limit, ...(query === undefined ? {} : { q: `name~"${query}"` }) },
  }
  const { values, incomplete } = await collect(target, settings, request, flag(ctx.values, 'all'))
  return emitRows(ctx, tables(values).map(repoRow), REPO_COLUMNS, settings, incomplete)
}, }

const repoViewVerb: CommandNode = { summary: 'One repository',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoArg(ctx.positionals[0] ?? option(ctx.values, 'repo'), target)
  const response = await httpRequest(target, { method: 'GET', path: repoPath(ref) }, settings)
  emitResult(ctx, repoDetail(isTable(response.json) ? response.json : {}, ref), { truncated: false })
  return 0
}, }

const repoCloneVerb: CommandNode = { summary: 'Clone a repository under settings.data_dir',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoArg(ctx.positionals[0] ?? option(ctx.values, 'repo'), target)
  const dir = option(ctx.values, 'dir') ?? join(expandHome(settings.data_dir), 'repos', ref.workspace, ref.repo)
  const url = `git@bitbucket.org:${ref.workspace}/${ref.repo}.git`

  if (existsSync(dir) && !flag(ctx.values, 'force')) {
    emitResult(ctx, { dir, url, skipped: true }, { truncated: false })
    return 0
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dirname(dir), { recursive: true })
  const result = await exec(['git', 'clone', url, dir], { timeoutMs: gitTimeoutMs(ctx, settings) })
  emitResult(ctx, { dir, url, exit_code: result.exitCode }, { truncated: false })
  return 0
}, }

const repoVerb: CommandNode = {
  summary: 'Repositories: list, view, clone',
  commands: { list: repoListVerb, view: repoViewVerb, clone: repoCloneVerb },
}

/* ------------------------------------------------------------------ *
 * `bb pipeline`
 * ------------------------------------------------------------------ */

const pipelineListVerb: CommandNode = { summary: 'Recent pipelines for a repository',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOptionOrPositional(ctx, target)
  const limit = intValue(ctx, 'limit', Math.min(settings.max_rows, 100), 1, 100)
  const request: HttpRequest = {
    method: 'GET',
    path: `${repoPath(ref)}/pipelines/`,
    query: { sort: '-created_on', pagelen: limit },
  }
  const { values, incomplete } = await collect(target, settings, request, flag(ctx.values, 'all'))
  return emitRows(ctx, tables(values).map(pipelineRow), PIPELINE_COLUMNS, settings, incomplete)
}, }

const pipelineViewVerb: CommandNode = { summary: 'One pipeline',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const uuid = positional(ctx, 'a pipeline uuid', 'see `crafty bb pipeline list`')
  const response = await httpRequest(
    target,
    { method: 'GET', path: `${repoPath(ref)}/pipelines/${uuid}` },
    settings,
  )
  emitResult(ctx, pipelineRow(isTable(response.json) ? response.json : {}), { truncated: false })
  return 0
}, }

const pipelineStepsVerb: CommandNode = { summary: 'The steps of one pipeline',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const uuid = positional(ctx, 'a pipeline uuid', 'see `crafty bb pipeline list`')
  const response = await httpRequest(
    target,
    { method: 'GET', path: `${repoPath(ref)}/pipelines/${uuid}/steps/` },
    settings,
  )
  const rows = tables(pageValues(response.json).values).map(stepRow)
  return emitRows(ctx, rows, STEP_COLUMNS, settings, false)
}, }

const pipelineLogsVerb: CommandNode = { summary: 'The raw log of a pipeline or one of its steps',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const uuid = positional(ctx, 'a pipeline uuid', 'see `crafty bb pipeline list`')
  const step = option(ctx.values, 'step')
  const path = step === undefined ? `${repoPath(ref)}/pipelines/${uuid}/log` : `${repoPath(ref)}/pipelines/${uuid}/steps/${step}/log`
  const response = await httpRequest(target, { method: 'GET', path, accept: 'text/plain' }, settings)
  if (ctx.json || ctx.format !== 'auto') {
    emitResult(ctx, { uuid, step: step ?? null, log: response.text }, { truncated: false })
    return 0
  }
  write(response.text)
  return 0
}, }

const pipelineRunVerb: CommandNode = { summary: 'Trigger a branch or custom pipeline',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const branch = option(ctx.values, 'branch')
  const custom = option(ctx.values, 'custom')
  if ((branch === undefined) === (custom === undefined)) {
    throw usageError('give exactly one of --branch or --custom')
  }
  const variables = (ctx.repeat['var'] ?? []).map((pair) => {
    const equals = pair.indexOf('=')
    if (equals <= 0) throw usageError(`--var needs KEY=VALUE, got "${pair}"`)
    return { key: pair.slice(0, equals), value: pair.slice(equals + 1) }
  })
  const body =
    branch !== undefined
      ? { target: { ref_type: 'branch', type: 'pipeline', ref_name: branch } }
      : { target: { type: 'pipeline', selector: { type: 'custom', pattern: custom } } }
  const request: HttpRequest = {
    method: 'POST',
    path: `${repoPath(ref)}/pipelines/`,
    body: { ...body, ...(variables.length === 0 ? {} : { variables }) },
  }
  const gate = gateMutation(ctx, `run a pipeline in ${ref.workspace}/${ref.repo}`, plannedRequest(target, request))
  if (gate === 'stop') return 0
  const response = await httpRequest(target, request, settings)
  emitResult(ctx, { http_status: response.status, pipeline: pipelineRow(isTable(response.json) ? response.json : {}) }, { truncated: false })
  return 0
}, }

const pipelineStopVerb: CommandNode = { summary: 'Stop a running pipeline',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const uuid = positional(ctx, 'a pipeline uuid', 'see `crafty bb pipeline list`')
  const path = `${repoPath(ref)}/pipelines/${uuid}`
  const stop: HttpRequest = { method: 'POST', path: `${path}/stopPipeline` }
  const gate = gateMutation(ctx, `stop pipeline ${uuid}`, plannedRequest(target, stop))
  if (gate === 'stop') return 0

  let response
  try {
    response = await httpRequest(target, stop, settings)
  } catch (error) {
    const failure = asOpsError(error)
    // Older Bitbucket deployments answer the stop with a PUT on the pipeline.
    if (failure.status !== 404) throw failure
    response = await httpRequest(target, { method: 'PUT', path, body: { target_state: 'STOPPED' } }, settings)
  }
  emitResult(ctx, { uuid, http_status: response.status, body: response.json ?? null }, { truncated: false })
  return 0
}, }

const pipelineVerb: CommandNode = {
  summary: 'Pipelines: list, view, steps, logs, run, stop',
  commands: {
    list: pipelineListVerb,
    view: pipelineViewVerb,
    steps: pipelineStepsVerb,
    logs: pipelineLogsVerb,
    run: pipelineRunVerb,
    stop: pipelineStopVerb,
  },
}

/* ------------------------------------------------------------------ *
 * `bb pr`
 * ------------------------------------------------------------------ */

const PR_STATES: Record<string, string> = { OPEN: 'OPEN', MERGED: 'MERGED', DECLINED: 'DECLINED' }
const MERGE_STRATEGIES = ['merge_commit', 'squash', 'fast_forward']

const prListVerb: CommandNode = { summary: 'Pull requests in a repository',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOptionOrPositional(ctx, target)
  const limit = intValue(ctx, 'limit', Math.min(settings.max_rows, 100), 1, 100)
  const rawState = option(ctx.values, 'state')
  if (rawState !== undefined && rawState !== 'ALL' && PR_STATES[rawState] === undefined) {
    throw usageError(`unknown --state "${rawState}"`, 'states: OPEN, MERGED, DECLINED, ALL')
  }
  const filters: string[] = []
  const source = option(ctx.values, 'source')
  const destination = option(ctx.values, 'target')
  if (source !== undefined) filters.push(`source.branch.name="${source}"`)
  if (destination !== undefined) filters.push(`destination.branch.name="${destination}"`)
  const request: HttpRequest = {
    method: 'GET',
    path: `${repoPath(ref)}/pullrequests`,
    query: {
      pagelen: limit,
      ...(rawState === undefined || rawState === 'ALL' ? {} : { state: rawState }),
      ...(filters.length === 0 ? {} : { q: filters.join(' AND ') }),
    },
  }
  const { values, incomplete } = await collect(target, settings, request, flag(ctx.values, 'all'))
  return emitRows(ctx, tables(values).map(prRow), PR_COLUMNS, settings, incomplete)
}, }

const prViewVerb: CommandNode = { summary: 'One pull request, with its comments',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const id = positional(ctx, 'a pull request id', 'see `crafty bb pr list`')
  const response = await httpRequest(target, { method: 'GET', path: `${repoPath(ref)}/pullrequests/${id}` }, settings)
  const row = prRow(isTable(response.json) ? response.json : {})
  if (!flag(ctx.values, 'comments')) {
    emitResult(ctx, row, { truncated: false })
    return 0
  }
  const comments = await httpRequest(
    target,
    { method: 'GET', path: `${repoPath(ref)}/pullrequests/${id}/comments` },
    settings,
  )
  emitResult(ctx, { ...row, comments: tables(pageValues(comments.json).values).map(commentRow) }, { truncated: false })
  return 0
}, }

const prCreateVerb: CommandNode = { summary: 'Open a pull request',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const title = required(ctx, 'title', '--title')
  const source = required(ctx, 'source', '--source B')
  const destination = option(ctx.values, 'target') ?? 'main'
  const description = option(ctx.values, 'description')
  const reviewers = ctx.repeat['reviewer'] ?? []
  const request: HttpRequest = {
    method: 'POST',
    path: `${repoPath(ref)}/pullrequests`,
    body: {
      title,
      source: { branch: { name: source } },
      destination: { branch: { name: destination } },
      ...(description === undefined ? {} : { description }),
      ...(reviewers.length === 0 ? {} : { reviewers: reviewers.map((uuid) => ({ uuid })) }),
      ...(flag(ctx.values, 'close-source-branch') ? { close_source_branch: true } : {}),
    },
  }
  const gate = gateMutation(ctx, `open a pull request in ${ref.workspace}/${ref.repo}`, plannedRequest(target, request))
  if (gate === 'stop') return 0
  const response = await httpRequest(target, request, settings)
  emitResult(ctx, prRow(isTable(response.json) ? response.json : {}), { truncated: false })
  return 0
}, }

const prCommentVerb: CommandNode = { summary: 'Comment on a pull request',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const id = positional(ctx, 'a pull request id', 'see `crafty bb pr list`')
  const text = required(ctx, 'text', '--text')
  const request: HttpRequest = {
    method: 'POST',
    path: `${repoPath(ref)}/pullrequests/${id}/comments`,
    body: { content: { raw: text } },
  }
  const gate = gateMutation(ctx, `comment on pull request ${id}`, plannedRequest(target, request))
  if (gate === 'stop') return 0
  const response = await httpRequest(target, request, settings)
  emitResult(ctx, commentRow(isTable(response.json) ? response.json : {}), { truncated: false })
  return 0
}, }

function prActionVerb(name: string, summary: string, action: string): CommandNode { return {
  summary,
  usage: [],
  run: async (ctx) => {
    const target = bitbucketTarget(ctx)
    const settings = loadConfig().settings
    const ref = repoOption(ctx, target)
    const id = positional(ctx, 'a pull request id', 'see `crafty bb pr list`')
    const request: HttpRequest = { method: 'POST', path: `${repoPath(ref)}/pullrequests/${id}/${action}` }
    const gate = gateMutation(ctx, `${name} pull request ${id}`, plannedRequest(target, request))
    if (gate === 'stop') return 0
    const response = await httpRequest(target, request, settings)
    emitResult(ctx, { id, action, http_status: response.status, pullrequest: prRow(isTable(response.json) ? response.json : {}) }, { truncated: false })
    return 0
  },
} }


const prDiffVerb: CommandNode = { summary: 'The diff of a pull request as text',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const id = positional(ctx, 'a pull request id', 'see `crafty bb pr list`')
  const response = await httpRequest(
    target,
    { method: 'GET', path: `${repoPath(ref)}/pullrequests/${id}/diff`, accept: 'text/plain' },
    settings,
  )
  if (flag(ctx.values, 'stat')) {
    // `git apply` resolves a patch against the repository it sits in, and a
    // pull-request diff belongs to no repository here: run it from a directory
    // that is not one, or a diff run inside a checkout reports 0 files.
    const stat = await exec(['git', 'apply', '--stat', '-'], {
      cwd: tmpdir(),
      stdin: response.text,
      timeoutMs: settings.timeout_ms,
    })
    write(stat.stdout)
    return 0
  }
  if (ctx.json || ctx.format !== 'auto') {
    emitResult(ctx, { id, diff: response.text }, { truncated: false })
    return 0
  }
  write(response.text)
  return 0
}, }

/** The task URL a 202 carries, or undefined when the body does not have one. */
function mergeTaskUrl(json: unknown): string | undefined {
  if (!isTable(json)) return undefined
  const links = isTable(json['links']) ? json['links'] : {}
  const self = isTable(links['self']) ? links['self'] : {}
  return typeof self['href'] === 'string' ? self['href'] : undefined
}

/** Polls the task until it leaves the pending states, or the timeout runs out. */
async function pollMergeTask(target: BitbucketTarget, settings: Settings, url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + settings.timeout_ms
  for (;;) {
    const response = await httpRequest(target, { method: 'GET', path: relativePath(target, url) }, settings)
    const body = isTable(response.json) ? response.json : {}
    const state = typeof body['task_status'] === 'string' ? body['task_status'] : ''
    const pending = state === 'PENDING' || state === 'IN_PROGRESS'
    if (!pending || Date.now() >= deadline) return body
    await Bun.sleep(500)
  }
}

const prMergeVerb: CommandNode = { summary: 'Merge a pull request',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const id = positional(ctx, 'a pull request id', 'see `crafty bb pr list`')
  const strategy = option(ctx.values, 'strategy')
  if (strategy !== undefined && !MERGE_STRATEGIES.includes(strategy)) {
    throw usageError(`unknown --strategy "${strategy}"`, `strategies: ${MERGE_STRATEGIES.join(', ')}`)
  }
  const message = option(ctx.values, 'message')
  const request: HttpRequest = {
    method: 'POST',
    path: `${repoPath(ref)}/pullrequests/${id}/merge`,
    body: {
      ...(strategy === undefined ? {} : { merge_strategy: strategy }),
      ...(message === undefined ? {} : { message }),
    },
  }
  const wait = flag(ctx.values, 'wait')
  const gate = gateMutation(ctx, `merge pull request ${id}`, plannedRequest(target, request))
  if (gate === 'stop') return 0
  const response = await httpRequest(target, request, settings)

  // A 202 means the merge runs as a task; the URL is polled so the verb
  // reports what actually happened rather than just "accepted".
  let task: Record<string, unknown> = {}
  if (response.status === 202) {
    const url = mergeTaskUrl(response.json)
    task = url === undefined ? {} : await pollMergeTask(target, settings, url)
  }
  const taskStatus = typeof task['task_status'] === 'string' ? task['task_status'] : null
  const mergeResult = typeof task['merge_result'] === 'boolean' ? task['merge_result'] : null
  if (wait && (taskStatus === 'FAILED' || mergeResult === false)) {
    throw new OpsError(`merge of pull request ${id} failed`, 'conflict', {
      status: response.status,
      hint: taskStatus ?? undefined,
    })
  }
  emitResult(ctx, { id, http_status: response.status, task_status: taskStatus, merge_result: mergeResult }, { truncated: false })
  return 0
}, }

const prVerb: CommandNode = {
  summary: 'Pull requests: list, view, create, comment, approve, decline, diff, merge',
  commands: {
    list: prListVerb,
    view: prViewVerb,
    create: prCreateVerb,
    comment: prCommentVerb,
    approve: prActionVerb('approve', 'Approve a pull request', 'approve'),
    decline: prActionVerb('decline', 'Decline a pull request', 'decline'),
    diff: prDiffVerb,
    merge: prMergeVerb,
  },
}

/* ------------------------------------------------------------------ *
 * `bb branch`
 * ------------------------------------------------------------------ */

const branchListVerb: CommandNode = { summary: 'Branches in a repository',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOptionOrPositional(ctx, target)
  const filter = option(ctx.values, 'filter')
  const request: HttpRequest = {
    method: 'GET',
    path: `${repoPath(ref)}/refs/branches`,
    query: { pagelen: 100, ...(filter === undefined ? {} : { q: `name~"${filter}"` }) },
  }
  const { values, incomplete } = await collect(target, settings, request, flag(ctx.values, 'all'))
  return emitRows(ctx, tables(values).map(branchRow), BRANCH_COLUMNS, settings, incomplete)
}, }

const branchCreateVerb: CommandNode = { summary: 'Create a branch from a ref',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const name = positional(ctx, 'a branch name')
  const from = required(ctx, 'from', '--from <ref>')
  const path = `${repoPath(ref)}/refs/branches`
  // the same shape the other dry-runs print: the URL the request will hit
  const gate = gateMutation(
    ctx,
    `create branch ${name} from ${from}`,
    plannedRequest(target, {
      method: 'POST',
      path,
      body: { name, target: { hash: `resolve(${from})` } },
    }),
  )
  if (gate === 'stop') return 0
  const commit = await httpRequest(target, { method: 'GET', path: `${repoPath(ref)}/commit/${from}` }, settings)
  const hash = isTable(commit.json) && typeof commit.json['hash'] === 'string' ? commit.json['hash'] : ''
  if (hash === '') throw new OpsError(`could not resolve ${from} to a commit`, 'not-found', { target: target.name })
  const response = await httpRequest(target, { method: 'POST', path, body: { name, target: { hash } } }, settings)
  emitResult(ctx, { name, hash, http_status: response.status }, { truncated: false })
  return 0
}, }

const branchDeleteVerb: CommandNode = { summary: 'Delete a branch',
usage: [],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoOption(ctx, target)
  const name = positional(ctx, 'a branch name')
  const request: HttpRequest = {
    method: 'DELETE',
    path: `${repoPath(ref)}/refs/branches/${encodeURIComponent(name)}`,
  }
  const gate = gateMutation(ctx, `delete branch ${name}`, plannedRequest(target, request))
  if (gate === 'stop') return 0
  const response = await httpRequest(target, request, settings)
  emitResult(ctx, { name, http_status: response.status, deleted: true }, { truncated: false })
  return 0
}, }

const branchVerb: CommandNode = {
  summary: 'Branches: list, create, delete',
  commands: { list: branchListVerb, create: branchCreateVerb, delete: branchDeleteVerb },
}

/* ------------------------------------------------------------------ *
 * Local clone: status, commit, push
 * ------------------------------------------------------------------ */

const statusVerb: CommandNode = { summary: 'Working tree status of the local clone',
usage: [
  'crafty bb status <workspace/repo> [options]',
  '',
  '`git status --porcelain -b` in settings.data_dir/repos/<workspace>/<repo>.',
  'The clone must exist; `crafty bb repo clone` creates it.',
  '',
  'Options:',
  '  --json      Print the envelope',
  '  -h, --help  Show this message',
],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoArg(ctx.positionals[0], target)
  const dir = requireClone(settings, ref)
  const result = await exec(['git', 'status', '--porcelain', '-b'], { cwd: dir, timeoutMs: settings.git_timeout_ms })
  emitResult(ctx, parseStatus(result.stdout, `${ref.workspace}/${ref.repo}`), { truncated: false })
  return 0
}, }

const commitVerb: CommandNode = { summary: 'Stage and commit in the local clone',
usage: [
  'crafty bb commit <workspace/repo> -m <message> [options]',
  '',
  'Stages changes and commits them in settings.data_dir/repos/<workspace>/<repo>.',
  'The identity comes from --author, then settings.git_author, then git itself.',
  'Nothing is pushed. Needs --yes; --dry-run prints the command and stops.',
  '',
  'Options:',
  '  -m, --message <text>  Commit message (required)',
  '  --files <a,b>         Stage only these paths (default: every change)',
  '  --all                 Stage every change (the default)',
  '  --branch <name>       Check out this branch first',
  '  --author <identity>   Name <email> for this commit',
  '  --yes                 Confirm the commit',
  '  --dry-run             Print the command and stop',
  '  --json                Print the envelope',
  '  -h, --help            Show this message',
],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoArg(ctx.positionals[0], target)
  const dir = requireClone(settings, ref)
  const message = required(ctx, 'message', '-m/--message')
  const files = listValue(ctx, 'files')
  if (files.length > 0 && flag(ctx.values, 'all')) throw usageError('give --files or --all, not both')
  const identity = gitIdentity(settings, option(ctx.values, 'author'))
  const commitArgv = ['git', ...identity, 'commit', '-m', message]
  const gate = gateMutation(ctx, `commit in ${ref.workspace}/${ref.repo}`, { argv: commitArgv })
  if (gate === 'stop') return 0

  const branch = option(ctx.values, 'branch')
  if (branch !== undefined) {
    await exec(['git', ...identity, 'checkout', branch], { cwd: dir, timeoutMs: settings.git_timeout_ms })
  }
  const addArgv = files.length > 0 ? ['git', ...identity, 'add', '--', ...files] : ['git', ...identity, 'add', '-A']
  await exec(addArgv, { cwd: dir, timeoutMs: settings.git_timeout_ms })
  const result = await exec(commitArgv, { cwd: dir, timeoutMs: settings.git_timeout_ms })
  emitResult(ctx, { repo: `${ref.workspace}/${ref.repo}`, output: result.stdout.trim() }, { truncated: false })
  return 0
}, }

const pushVerb: CommandNode = { summary: 'Push the local clone to origin',
usage: [
  'crafty bb push <workspace/repo> [options]',
  '',
  '`git push origin <branch>` in settings.data_dir/repos/<workspace>/<repo>.',
  'Never forces; the branch defaults to the one checked out. Needs --yes;',
  '--dry-run prints the command and stops.',
  '',
  'Options:',
  '  --branch <name>  Branch to push (default: the checked-out branch)',
  '  --yes            Confirm the push',
  '  --dry-run        Print the command and stop',
  '  --json           Print the envelope',
  '  -h, --help       Show this message',
],
run: async (ctx) => {
  const target = bitbucketTarget(ctx)
  const settings = loadConfig().settings
  const ref = repoArg(ctx.positionals[0], target)
  const dir = requireClone(settings, ref)
  const configured = option(ctx.values, 'branch')
  const branch =
    configured ??
    (await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeoutMs: settings.git_timeout_ms })).stdout.trim()
  const argv = ['git', 'push', 'origin', branch]
  const gate = gateMutation(ctx, `push ${branch} in ${ref.workspace}/${ref.repo}`, { argv })
  if (gate === 'stop') return 0
  const result = await exec(argv, { cwd: dir, timeoutMs: settings.git_timeout_ms })
  emitResult(ctx, { repo: `${ref.workspace}/${ref.repo}`, branch, output: `${result.stdout}${result.stderr}`.trim() }, { truncated: false })
  return 0
}, }

/* ------------------------------------------------------------------ *
 * The group
 * ------------------------------------------------------------------ */

/** Declared once: the parser only knows the options it is told about. */
const BB_OPTIONS: OptionSpec[] = [
  { name: 'repo', type: 'string' },
  { name: 'query', type: 'string' },
  { name: 'limit', type: 'string' },
  { name: 'all', type: 'boolean' },
  { name: 'filter', type: 'string' },
  { name: 'dir', type: 'string' },
  { name: 'force', type: 'boolean' },
  { name: 'timeout', type: 'string' },
  { name: 'branch', type: 'string' },
  { name: 'custom', type: 'string' },
  { name: 'var', type: 'string' },
  { name: 'step', type: 'string' },
  { name: 'state', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'target', type: 'string' },
  { name: 'title', type: 'string' },
  { name: 'description', type: 'string' },
  { name: 'reviewer', type: 'string' },
  { name: 'close-source-branch', type: 'boolean' },
  { name: 'text', type: 'string' },
  { name: 'comments', type: 'boolean' },
  { name: 'stat', type: 'boolean' },
  { name: 'strategy', type: 'string' },
  { name: 'message', type: 'string', short: 'm' },
  { name: 'wait', type: 'boolean' },
  { name: 'from', type: 'string' },
  { name: 'files', type: 'string' },
  { name: 'author', type: 'string' },
  { name: 'yes', type: 'boolean' },
  { name: 'dry-run', type: 'boolean' },
]

export default {
  name: 'bb',
  aliases: ['bitbucket'],
  summary: 'Bitbucket Cloud repositories, pipelines, pull requests and branches',
  source: 'bitbucket',
  options: BB_OPTIONS,
  repeatable: ['var', 'reviewer'],
  commands: {
    repo: repoVerb,
    pipeline: pipelineVerb,
    pr: prVerb,
    branch: branchVerb,
    status: statusVerb,
    commit: commitVerb,
    push: pushVerb,
  },
} satisfies CommandModule
