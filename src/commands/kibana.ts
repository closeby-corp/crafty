/**
 * `crafty kibana`: the read-only half of the Kibana API. The console proxy is the
 * one way to run a search without a saved-object id, and it wants the `kbn-xsrf`
 * header on every non-GET call.
 */
import type { OptionSpec } from '../cli.ts'
import { OpsError, usageError } from '../errors.ts'
import { httpRequest } from '../http.ts'
import { emitResult, intValue, option, type Ctx } from '../output.ts'
import type { CommandModule, CommandNode } from '../command.ts'
import { levelClause, levelField, textClause, textFields } from '../fields.ts'
import { parseSince } from '../time.ts'
import { loadConfig, resolveTarget, type KibanaTarget, type Settings } from '../targets.ts'
import { isTable } from '../values.ts'

/** Kibana's saved-object types, as the API spells them. */
const SAVED_TYPES = ['index-pattern', 'search', 'dashboard']

/** The time field an `_search` over a filebeat-style index uses. */
const TIME_FIELD = '@timestamp'

const targetOption: OptionSpec = { name: 'target', type: 'string' }

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

/** The kibana target the verb reads, plus the settings its HTTP call needs. */
function targetFor(ctx: Ctx): { target: KibanaTarget; settings: Settings } {
  if (ctx.positionals.length > 1) {
    throw usageError(`this verb takes one target, got ${ctx.positionals.length}`)
  }
  const file = loadConfig()
  const name = option(ctx.values, 'target') ?? ctx.positionals[0]
  const resolved = resolveTarget(file, 'kibana', name)
  if (resolved.kind !== 'kibana') {
    throw new OpsError(`target "${resolved.name}" is a ${resolved.kind} target, not kibana`, 'config')
  }
  ctx.target = resolved.name
  return { target: resolved, settings: file.settings }
}

/** The client-side row cap every row-set verb applies. */
function capped<T>(settings: Settings, rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length <= settings.max_rows
    ? { rows, truncated: false }
    : { rows: rows.slice(0, settings.max_rows), truncated: true }
}

/** A `--dsl` value: one JSON object, or a usage error naming the flag. */
function parseDsl(text: string, flagName: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw usageError(`${flagName} is not valid JSON: ${(error as Error).message}`)
  }
  if (!isTable(parsed)) throw usageError(`${flagName} must be a JSON object`)
  return parsed
}

/**
 * The `_search` body: `--query` becomes a query_string, `--level`/`--text` use
 * the field catalog the config file carries, and `--dsl` replaces the whole body
 * but keeps `size` when it omits it.
 */
function searchBody(ctx: Ctx, target: KibanaTarget): Record<string, unknown> {
  const size = intValue(ctx, 'size', 50, 1, 10_000)
  const dsl = option(ctx.values, 'dsl')
  const text = option(ctx.values, 'query')
  const level = option(ctx.values, 'level')
  const free = option(ctx.values, 'text')
  if (dsl !== undefined && (text !== undefined || level !== undefined || free !== undefined)) {
    throw usageError('--dsl replaces the search body', 'use it alone, or use --query/--level/--text')
  }
  if (dsl !== undefined) return { size, ...parseDsl(dsl, '--dsl') }

  const must: unknown[] = []
  if (text !== undefined) must.push({ query_string: { query: text, analyze_wildcard: true } })
  if (level !== undefined) {
    const field = option(ctx.values, 'level-field') ?? levelField('kibana', target)
    if (field === undefined) throw usageError('this target has no level field', 'set level_field in its config')
    must.push(levelClause(field, level))
  }
  if (free !== undefined) must.push(textClause(textFields('kibana', target), free))

  const since = parseSince(option(ctx.values, 'since') ?? '1h')
  return {
    query: { bool: { must, filter: [{ range: { [TIME_FIELD]: { gte: since.iso } } }] } },
    size,
  }
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

const statusVerb: CommandNode = {
  summary: 'Kibana version and overall status',
  usage: [
    'crafty kibana status [target] [options]',
    '',
    '`GET /api/status`, flattened to the name, version and overall level the',
    'operator actually reads. Read-only.',
    '',
    'Options:',
    '  --target <name>  Kibana target (default: settings.default_targets.kibana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [targetOption],
  run: async (ctx) => {
    const { target, settings } = targetFor(ctx)
    const response = await httpRequest(target, { method: 'GET', path: '/api/status' }, settings)
    emitResult(ctx, statusSummary(response.json), { truncated: false })
    return 0
  },
}

/** The status body nests the two useful fields one level down. */
function statusSummary(json: unknown): Record<string, unknown> {
  if (!isTable(json)) return { name: undefined, version: undefined, status: undefined, summary: undefined }
  const version = isTable(json['version']) ? json['version']['number'] : undefined
  const overall = isTable(json['status']) && isTable(json['status']['overall']) ? json['status']['overall'] : undefined
  return {
    name: json['name'],
    version,
    status: overall?.['level'],
    summary: overall?.['summary'],
  }
}

const spacesVerb: CommandNode = {
  summary: 'List the Kibana spaces',
  usage: [
    'crafty kibana spaces [target] [options]',
    '',
    '`GET /api/spaces/space`, one row per space. Read-only.',
    '',
    'Options:',
    '  --target <name>  Kibana target (default: settings.default_targets.kibana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [targetOption],
  run: async (ctx) => {
    const { target, settings } = targetFor(ctx)
    const response = await httpRequest(target, { method: 'GET', path: '/api/spaces/space' }, settings)
    const spaces = Array.isArray(response.json) ? response.json : []
    const rows = spaces.filter(isTable).map((space) => ({
      id: space['id'],
      name: space['name'],
      description: space['description'],
    }))
    const { rows: kept, truncated } = capped(settings, rows)
    emitResult(ctx, kept, { columns: ['id', 'name', 'description'], truncated })
    return 0
  },
}

const savedVerb: CommandNode = {
  summary: 'Find saved objects by type',
  usage: [
    'crafty kibana saved [target] --type <type> [options]',
    '',
    '`GET /api/saved_objects/_find`, one row per saved object. Read-only.',
    '',
    'Options:',
    '  --type <type>    index-pattern, search or dashboard (required)',
    '  --search <text>  Only objects whose title matches the text',
    '  --size <n>       per_page, the number of objects to fetch (default 20)',
    '  --target <name>  Kibana target (default: settings.default_targets.kibana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [
    targetOption,
    { name: 'type', type: 'string' },
    { name: 'search', type: 'string' },
    { name: 'size', type: 'string' },
  ],
  run: async (ctx) => {
    const { target, settings } = targetFor(ctx)
    const type = option(ctx.values, 'type')
    if (type === undefined) throw usageError('--type is required', `types: ${SAVED_TYPES.join(', ')}`)
    if (!SAVED_TYPES.includes(type)) throw usageError(`unknown saved-object type "${type}"`, `types: ${SAVED_TYPES.join(', ')}`)
    const size = intValue(ctx, 'size', 20, 1, 10_000)
    const search = option(ctx.values, 'search')
    const response = await httpRequest(
      target,
      {
        method: 'GET',
        path: '/api/saved_objects/_find',
        query: { type, per_page: size, ...(search === undefined ? {} : { search }) },
      },
      settings,
    )
    const found = isTable(response.json) && Array.isArray(response.json['saved_objects']) ? response.json['saved_objects'] : []
    const rows = found.filter(isTable).map((object) => ({
      id: object['id'],
      type: object['type'],
      title: isTable(object['attributes']) ? object['attributes']['title'] : undefined,
    }))
    const { rows: kept, truncated } = capped(settings, rows)
    emitResult(ctx, kept, { columns: ['id', 'type', 'title'], truncated })
    return 0
  },
}

const queryVerb: CommandNode = {
  summary: 'Search an index through the Kibana console proxy',
  usage: [
    'crafty kibana query [target] --index <index> [--query <text> | --dsl <json>] [options]',
    '',
    'Runs `POST <index>/_search` through Kibana\'s console proxy, so a search',
    'needs no saved-object id. --query is a query_string; --level and --text use',
    'the field names this target publishes (log_level, message), so the documented',
    '"use log_level, not level" is the behaviour rather than a note. --dsl',
    'replaces the whole body. Either way `size` is kept unless the JSON sets it.',
    '',
    'The default window is the last hour, applied to @timestamp.',
    '',
    'Options:',
    '  --index <index>  Index or pattern to search (default: target default_index)',
    '  --query <text>   Lucene query_string, analyze_wildcard on',
    '  --dsl <json>     A full Elasticsearch query body, as one JSON object',
    '  --since <when>   Start of the window (default 1h)',
    '  --size <n>       Hits to fetch (default 50)',
    '  --target <name>  Kibana target (default: settings.default_targets.kibana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [
    targetOption,
    { name: 'index', type: 'string' },
    { name: 'query', type: 'string' },
    { name: 'dsl', type: 'string' },
    { name: 'level', type: 'string' },
    { name: 'level-field', type: 'string' },
    { name: 'text', type: 'string' },
    { name: 'since', type: 'string' },
    { name: 'size', type: 'string' },
  ],
  run: async (ctx) => {
    const { target, settings } = targetFor(ctx)
    const index = option(ctx.values, 'index') ?? target.default_index
    if (index === undefined || index === '') {
      throw usageError('there is no index to search', `pass --index, or set default_index on target ${target.name}`)
    }
    const body = searchBody(ctx, target)
    const response = await httpRequest(
      target,
      {
        method: 'POST',
        path: '/api/console/proxy',
        query: { path: `${index}/_search`, method: 'POST' },
        body,
        headers: { 'kbn-xsrf': 'true' },
        retryable: true,
      },
      settings,
    )
    const hits =
      isTable(response.json) && isTable(response.json['hits']) && Array.isArray(response.json['hits']['hits'])
        ? response.json['hits']['hits']
        : []
    const rows = hits.filter(isTable).map((hit) => ({
      _index: hit['_index'],
      _id: hit['_id'],
      _source: hit['_source'],
    }))
    const { rows: kept, truncated } = capped(settings, rows)
    emitResult(ctx, kept, { columns: ['_index', '_id', '_source'], truncated })
    return 0
  },
}

export default {
  name: 'kibana',
  summary: 'Read Kibana status, spaces, saved objects and proxied searches',
  source: 'kibana',
  commands: { status: statusVerb, spaces: spacesVerb, saved: savedVerb, query: queryVerb },
} satisfies CommandModule
