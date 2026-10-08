/**
 * `crafty opensearch` (alias `os`): cluster health, index listings, mappings,
 * counts and log searches. Every verb is read-only and speaks the one envelope.
 */
import { OpsError, usageError } from 'crafty'
import { httpRequest } from '../lib/http.ts'
import { emitResult, flag, intValue, listValue, option } from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { requireTarget, loadConfig } from '../lib/targets.ts'
import type { OpenSearchTarget, Settings } from '../lib/targets.ts'
import { levelClause, levelField, textClause, textFields } from '../lib/fields.ts'
import { parseSince, parseUntil } from '../lib/time.ts'
import { isTable } from '../lib/values.ts'

type Json = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * Reading the target and the search reply
 * ------------------------------------------------------------------ */

/** Resolves the target, records it on the context, and narrows its kind. */
function targetFrom(ctx: Ctx, positional?: string): OpenSearchTarget {
  const target = requireTarget('opensearch', positional ?? option(ctx.values, 'target'))
  if (target.kind !== 'opensearch') {
    throw new OpsError(`target "${target.name}" is a ${target.kind} target, not an opensearch target`, 'config')
  }
  ctx.target = target.name
  return target
}

/** `hits.hits` of a `_search` reply, dropping anything that is not a hit table. */
function hitsOf(json: unknown): Json[] {
  if (!isTable(json)) return []
  const hits = json['hits']
  if (!isTable(hits)) return []
  const list = hits['hits']
  return Array.isArray(list) ? list.filter(isTable) : []
}

function scrollIdOf(json: unknown): string | undefined {
  if (!isTable(json)) return undefined
  const id = json['_scroll_id']
  return typeof id === 'string' ? id : undefined
}

/**
 * The fixed row shape: the hit's coordinates, `ts` from the target's time
 * field, the requested fields lifted up, and the whole `_source` last.
 */
function rowsFromHits(hits: Json[], target: OpenSearchTarget, fields: string[]): Json[] {
  return hits.map((hit) => {
    const source = isTable(hit['_source']) ? hit['_source'] : {}
    const row: Json = { _index: hit['_index'], _id: hit['_id'] }
    const ts = readPath(source, target.time_field)
    if (ts !== undefined) row['ts'] = ts
    for (const field of fields) {
      const value = readPath(source, field)
      if (value !== undefined) row[field] = value
    }
    row['_source'] = source
    return row
  })
}

/** A dotted path into `_source`, so `--fields kubernetes.namespace` works. */
function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const key of path.split('.')) {
    if (!isTable(current)) return undefined
    current = current[key]
  }
  return current
}

/* ------------------------------------------------------------------ *
 * Body assembly
 * ------------------------------------------------------------------ */

function sortOrder(ctx: Ctx): 'asc' | 'desc' {
  const raw = option(ctx.values, 'sort')
  if (raw === undefined) return 'desc'
  if (raw !== 'asc' && raw !== 'desc') throw usageError(`unknown --sort "${raw}"`, 'values: asc, desc')
  return raw
}

const DEFAULT_WINDOW = '1h'

/** The window filter: `--since` defaults to 1h, like every other log verb. */
function rangeFilter(target: OpenSearchTarget, ctx: Ctx): Json {
  const rawSince = option(ctx.values, 'since') ?? DEFAULT_WINDOW
  const rawUntil = option(ctx.values, 'until')
  const bounds: Json = { gte: parseSince(rawSince).iso }
  if (rawUntil !== undefined && rawUntil !== '') bounds['lte'] = parseUntil(rawUntil).iso
  return { range: { [target.time_field]: bounds } }
}

/**
 * The body when no `--dsl` was given: bool must/filter, widened by the flags.
 * `--level` and `--text` use the field names this target publishes, so an EKS
 * query searches `log`/`message`/`msg` without the caller knowing.
 */
function assembledBody(ctx: Ctx, target: OpenSearchTarget, range: Json): Json {
  const queryText = option(ctx.values, 'query')
  const level = option(ctx.values, 'level')
  const free = option(ctx.values, 'text')
  const must: Json[] = []
  if (queryText !== undefined) must.push({ query_string: { query: queryText, analyze_wildcard: true } })
  if (level !== undefined) {
    const field = option(ctx.values, 'level-field') ?? levelField('opensearch', target)
    if (field === undefined) throw usageError('this target has no level field', 'set level_field in its config')
    must.push(levelClause(field, level))
  }
  if (free !== undefined) must.push(textClause(textFields('opensearch', target), free))
  return { query: { bool: { must, filter: [range] } } }
}

/** `--dsl` as inline JSON, or read from `--dsl-file`. */
async function dslBody(dsl: string | undefined, dslFile: string | undefined): Promise<Json> {
  let text = dsl
  if (text === undefined && dslFile !== undefined) {
    const file = Bun.file(dslFile)
    if (!(await file.exists())) {
      throw usageError(`no such file: ${dslFile}`, '--dsl-file wants a path to a JSON object')
    }
    text = await file.text()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text ?? '')
  } catch (error) {
    throw usageError(`the search body is not valid JSON: ${(error as Error).message}`)
  }
  if (!isTable(parsed)) throw usageError('the search body must be a JSON object', 'it replaces the whole _search body')
  return parsed
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

const healthVerb: CommandNode = {
  summary: 'Cluster health document',
  usage: [
    'crafty os health [target] [options]',
    '',
    '`GET /_cluster/health`, printed as it came back. Read-only.',
    '',
    'Options:',
    '  --target <name>  Target from the config file, when it is not the default',
    '  --json           Print the envelope',
    '  --format <kind>  json, table, csv or plain',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => {
    const target = targetFrom(ctx, ctx.positionals[0])
    const response = await httpRequest(target, { method: 'GET', path: '/_cluster/health' }, loadConfig().settings)
    emitResult(ctx, response.json ?? {}, { truncated: false })
    return 0
  },
}

const indicesVerb: CommandNode = {
  summary: 'Index names, health and sizes',
  usage: [
    'crafty os indices [options]',
    '',
    'One row per index from `_cat/indices`: name, health, status, docs.count and',
    'store.size. `--pattern` filters the names locally (a glob, or a plain',
    'substring). Read-only.',
    '',
    'Options:',
    '  --target <name>   Target from the config file, when it is not the default',
    '  --pattern <glob>  Keep only indices whose name matches',
    '  --all             Include hidden and system indices (expand_wildcards=all)',
    '  --json            Print the envelope',
    '  --format <kind>   json, table, csv or plain',
    '  -h, --help        Show this message',
  ],
  options: [
    { name: 'target', type: 'string' },
    { name: 'pattern', type: 'string' },
    { name: 'all', type: 'boolean' },
  ],
  run: async (ctx) => {
    const target = targetFrom(ctx)
    const settings = loadConfig().settings
    const response = await httpRequest(
      target,
      {
        method: 'GET',
        path: '/_cat/indices',
        query: {
          format: 'json',
          h: 'index,health,status,docs.count,store.size',
          ...(flag(ctx.values, 'all') ? { expand_wildcards: 'all' } : {}),
        },
      },
      settings,
    )
    const listed = Array.isArray(response.json) ? response.json.filter(isTable) : []
    const rows: Json[] = listed.map((entry) => ({
      index: entry['index'],
      health: entry['health'],
      status: entry['status'],
      'docs.count': entry['docs.count'],
      'store.size': entry['store.size'],
    }))

    const pattern = option(ctx.values, 'pattern')
    const kept = pattern === undefined ? rows : rows.filter((row) => matchesIndex(String(row['index']), pattern))
    const truncated = kept.length > settings.max_rows
    emitResult(ctx, truncated ? kept.slice(0, settings.max_rows) : kept, {
      columns: ['index', 'health', 'status', 'docs.count', 'store.size'],
      truncated,
    })
    return 0
  },
}

/** A glob when it carries a wildcard, a case-insensitive substring otherwise. */
function matchesIndex(name: string, pattern: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return name.toLowerCase().includes(pattern.toLowerCase())
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(name)
}

const mappingVerb: CommandNode = {
  summary: 'Field mapping of one index',
  usage: [
    'crafty os mapping <index> [options]',
    '',
    '`GET /<index>/_mapping`, printed as-is. The index may be an expression,',
    'such as `logs-*`. Read-only.',
    '',
    'Options:',
    '  --target <name>  Target from the config file, when it is not the default',
    '  --json           Print the envelope',
    '  --format <kind>  json, table, csv or plain',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => {
    const index = ctx.positionals[0]
    if (index === undefined) throw usageError('an index is required', 'as in `crafty os mapping logs-app`')
    const target = targetFrom(ctx)
    const response = await httpRequest(target, { method: 'GET', path: `/${index}/_mapping` }, loadConfig().settings)
    emitResult(ctx, response.json ?? {}, { truncated: false })
    return 0
  },
}

const countVerb: CommandNode = {
  summary: 'Document count for an index expression',
  usage: [
    'crafty os count [options]',
    '',
    '`POST /<index>/_count`, optionally narrowed by a Lucene query string.',
    'Read-only.',
    '',
    'Options:',
    '  --index <index>  Index or expression (default the target default_index)',
    '  --query <text>   Lucene query string to count',
    '  --target <name>  Target from the config file, when it is not the default',
    '  --json           Print the envelope',
    '  --format <kind>  json, table, csv or plain',
    '  -h, --help       Show this message',
  ],
  options: [
    { name: 'index', type: 'string' },
    { name: 'query', type: 'string' },
    { name: 'target', type: 'string' },
  ],
  run: async (ctx) => {
    const target = targetFrom(ctx)
    const index = option(ctx.values, 'index') ?? target.default_index
    const queryText = option(ctx.values, 'query')
    const body = queryText === undefined ? {} : { query: { query_string: { query: queryText, analyze_wildcard: true } } }
    const response = await httpRequest(
      target,
      { method: 'POST', path: `/${index}/_count`, body, retryable: true },
      loadConfig().settings,
    )
    emitResult(ctx, response.json ?? {}, { truncated: false })
    return 0
  },
}

/** The scroll leg of `--all`: page until empty, then release the cursor. */
async function scrollRows(
  target: OpenSearchTarget,
  settings: Settings,
  index: string,
  body: Json,
  fields: string[],
): Promise<Json[]> {
  const first = await httpRequest(
    target,
    { method: 'POST', path: `/${index}/_search`, query: { scroll: '1m' }, body, retryable: true },
    settings,
  )
  let scrollId = scrollIdOf(first.json)
  let hits = hitsOf(first.json)
  const rows = rowsFromHits(hits, target, fields)

  while (scrollId !== undefined && hits.length > 0) {
    const page = await httpRequest(
      target,
      { method: 'POST', path: '/_search/scroll', body: { scroll: '1m', scroll_id: scrollId }, retryable: true },
      settings,
    )
    scrollId = scrollIdOf(page.json) ?? scrollId
    hits = hitsOf(page.json)
    rows.push(...rowsFromHits(hits, target, fields))
  }

  if (scrollId !== undefined) {
    // The hits are already in hand; a failed cleanup must not discard them.
    try {
      await httpRequest(target, { method: 'DELETE', path: '/_search/scroll', body: { scroll_id: scrollId } }, settings)
    } catch {
      /* best effort */
    }
  }
  return rows
}

const queryVerb: CommandNode = {
  summary: 'Search an index and print the hits',
  usage: [
    'crafty os query [options]',
    '',
    'Searches one index expression and prints one row per hit: `_index`, `_id`,',
    '`ts` from the target time_field, any `--fields` lifted up, and the whole',
    '`_source`. `--query` pushes a query string into `bool.must`; `--since`',
    '(default 1h) and `--until` push a range into `bool.filter`;',
    '`--dsl`/`--dsl-file` replaces the',
    'body (size and sort are still defaulted when the JSON omits them).',
    '',
    '`--all` follows the scroll API to the end of the result set; without it one',
    'page of `--size` hits is read and the client caps the rows at',
    'settings.max_rows. Read-only.',
    '',
    'Options:',
    '  --index <index>   Index or expression (default the target default_index)',
    '  --query <text>    Lucene query string, pushed into bool.must',
    '  --level <level>   Match the level field this target publishes',
    '  --level-field <f> Override that field, when the index family differs',
    '  --text <text>     Free text across the fields this target publishes',
    '  --dsl <json>      Replace the whole search body',
    '  --dsl-file <path> Read the search body from a file',
    '  --since <when>    Lower bound of the window (default 1h)',
    '  --until <when>    Upper bound of the window',
    '  --fields <a,b>    Lift these _source fields next to ts',
    '  --size <n>        Hits per page (default 50)',
    '  --sort <asc|desc> Sort on the target time_field (default desc)',
    '  --all             Scroll to the end of the result set',
    '  --target <name>   Target from the config file, when it is not the default',
    '  --json            Print the envelope',
    '  --format <kind>   json, table, csv or plain',
    '  -h, --help        Show this message',
  ],
  options: [
    { name: 'index', type: 'string' },
    { name: 'query', type: 'string' },
    { name: 'dsl', type: 'string' },
    { name: 'level', type: 'string' },
    { name: 'level-field', type: 'string' },
    { name: 'text', type: 'string' },
    { name: 'dsl-file', type: 'string' },
    { name: 'since', type: 'string' },
    { name: 'until', type: 'string' },
    { name: 'fields', type: 'string' },
    { name: 'size', type: 'string' },
    { name: 'sort', type: 'string' },
    { name: 'all', type: 'boolean' },
    { name: 'target', type: 'string' },
  ],
  run: async (ctx) => {
    const target = targetFrom(ctx)
    const settings = loadConfig().settings
    const index = option(ctx.values, 'index') ?? target.default_index
    // Validate every flag before the first request, so a typo never hits the cluster.
    const fields = listValue(ctx, 'fields')
    const size = intValue(ctx, 'size', 50, 1, 100_000)
    const order = sortOrder(ctx)
    const range = rangeFilter(target, ctx)

    const dsl = option(ctx.values, 'dsl')
    const dslFile = option(ctx.values, 'dsl-file')
    if (dsl !== undefined && dslFile !== undefined) throw usageError('give --dsl or --dsl-file, not both')
    const queryText = option(ctx.values, 'query')
    const named = queryText !== undefined || option(ctx.values, 'level') !== undefined || option(ctx.values, 'text') !== undefined
    if (named && (dsl !== undefined || dslFile !== undefined)) {
      throw usageError(
        '--query/--level/--text and --dsl build the same part of the body',
        'put the query inside the DSL, or use one of the two',
      )
    }

    const body =
      dsl !== undefined || dslFile !== undefined ? await dslBody(dsl, dslFile) : assembledBody(ctx, target, range)
    if (body['size'] === undefined) body['size'] = size
    if (body['sort'] === undefined) body['sort'] = [{ [target.time_field]: { order } }]
    if (fields.length > 0 && body['_source'] === undefined) body['_source'] = fields

    const scroll = flag(ctx.values, 'all')
    const cap = scroll ? Number.MAX_SAFE_INTEGER : settings.max_rows
    const rows = scroll
      ? await scrollRows(target, settings, index, body, fields)
      : rowsFromHits(
          hitsOf(
            (
              await httpRequest(
                target,
                { method: 'POST', path: `/${index}/_search`, body, retryable: true },
                settings,
              )
            ).json,
          ),
          target,
          fields,
        )

    const truncated = rows.length > cap
    const columns = ['_index', '_id', 'ts', ...fields, '_source']
    emitResult(ctx, truncated ? rows.slice(0, cap) : rows, { columns, truncated })
    return 0
  },
}

export default {
  name: 'opensearch',
  summary: 'Read cluster health, indices, mappings, counts and logs from OpenSearch',
  aliases: ['os'],
  source: 'opensearch',
  commands: {
    health: healthVerb,
    indices: indicesVerb,
    mapping: mappingVerb,
    count: countVerb,
    query: queryVerb,
  },
} satisfies CommandModule
