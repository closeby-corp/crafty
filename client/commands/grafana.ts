/**
 * `crafty grafana`: the read side of the Grafana API - health, data sources,
 * dashboards, annotations and the datasource query proxy. The query POST is the
 * one write-looking call that is safe to retry: it only ever reads a datasource.
 */
import { OpsError, usageError } from 'crafty'
import { httpRequest } from '../lib/http.ts'
import { emitResult, flag, option, required } from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { loadConfig, requireTarget } from '../lib/targets.ts'
import type { GrafanaTarget, Settings } from '../lib/targets.ts'
import { parseSince, parseUntil, toGrafanaFrom } from '../lib/time.ts'
import { isTable } from '../lib/values.ts'

/** One flattened series: the field's name (with labels) and its points. */
export interface GrafanaSeries {
  metric: string
  points: Array<[number | null, number | null]>
}

/* ------------------------------------------------------------------ *
 * Target and shared pieces
 * ------------------------------------------------------------------ */

/**
 * Resolves the target the way every HTTP verb does: `--target`, then the
 * configured default, then the only grafana target. Sets `ctx.target` so a
 * failure carries the target name.
 */
function grafanaTarget(ctx: Ctx): { target: GrafanaTarget; settings: Settings } {
  const resolved = requireTarget('grafana', option(ctx.values, 'target'))
  if (resolved.kind !== 'grafana') {
    throw new OpsError(`target "${resolved.name}" is not a grafana target`, 'config')
  }
  ctx.target = resolved.name
  return { target: resolved, settings: loadConfig().settings }
}

/** Caps a row set client-side, which is the only place truncation happens. */
function emitRows(ctx: Ctx, rows: Record<string, unknown>[], settings: Settings, columns: string[]): number {
  const kept = rows.slice(0, settings.max_rows)
  emitResult(ctx, kept, { columns, truncated: kept.length < rows.length })
  return 0
}

const STEP_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `--step` as a duration (`30s`, `5m`, `1h`, or a bare count of seconds). */
function parseStep(value: string): number {
  const matched = /^(\d+(?:\.\d+)?)(s|m|h|d|w)?$/.exec(value.trim())
  const ms = matched === null ? Number.NaN : Math.round(Number(matched[1]) * (matched[2] === undefined ? 1_000 : STEP_UNITS[matched[2]]!))
  if (!Number.isFinite(ms) || ms <= 0) {
    throw usageError(`--step must be a positive duration like 30s, 5m or 1h`, `got "${value}"`)
  }
  return ms
}

/**
 * A datasource is named either by its uid or its display name; Grafana's query
 * API only wants the uid, so both forms resolve through the list endpoint.
 */
async function resolveDatasourceUid(target: GrafanaTarget, wanted: string, settings: Settings): Promise<string> {
  const response = await httpRequest(target, { method: 'GET', path: '/api/datasources' }, settings)
  const list = Array.isArray(response.json) ? response.json.filter(isTable) : []
  const found = list.find((datasource) => datasource['uid'] === wanted || datasource['name'] === wanted)
  if (found === undefined) {
    const names = list.map((datasource) => String(datasource['name'] ?? datasource['uid'] ?? '?')).join(', ')
    throw new OpsError(`no datasource named or with uid "${wanted}"`, 'not-found', {
      hint: names === '' ? 'the target exposes no datasources' : `datasources: ${names}`,
    })
  }
  const uid = found['uid']
  if (typeof uid !== 'string' || uid === '') {
    throw new OpsError(`datasource "${wanted}" has no uid`, 'upstream')
  }
  return uid
}

/* ------------------------------------------------------------------ *
 * Frame flattening
 * ------------------------------------------------------------------ */

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** Grafana time fields are epoch milliseconds, but a table frame may hold ISO. */
function timeMs(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

/** `Value{instance="host:9100"}` when the field carries labels, else its name. */
function metricName(field: Record<string, unknown>): string {
  const name = typeof field['name'] === 'string' ? field['name'] : ''
  const labels = field['labels']
  if (!isTable(labels) || Object.keys(labels).length === 0) return name
  const pairs = Object.entries(labels)
    .map(([key, value]) => `${key}="${String(value)}"`)
    .join(',')
  return `${name}{${pairs}}`
}

function seriesOfFrame(frame: unknown): GrafanaSeries[] {
  if (!isTable(frame)) return []
  const schema = frame['schema']
  const fields = isTable(schema) && Array.isArray(schema['fields']) ? schema['fields'] : []
  const data = frame['data']
  const dataValues = isTable(data) && Array.isArray(data['values']) ? data['values'] : []
  const descriptors = fields.length > 0 ? fields : dataValues.map((_, index) => ({ name: `field${index}` }))
  const columns = descriptors.map((descriptor, index): unknown[] => {
    const column = dataValues[index]
    if (Array.isArray(column)) return column
    if (isTable(descriptor) && Array.isArray(descriptor['values'])) return descriptor['values']
    return []
  })
  const timeIndex = descriptors.findIndex(
    (descriptor) => isTable(descriptor) && (descriptor['type'] === 'time' || descriptor['name'] === 'Time'),
  )
  const times = timeIndex === -1 ? [] : (columns[timeIndex] ?? [])
  const series: GrafanaSeries[] = []
  descriptors.forEach((descriptor, index) => {
    if (index === timeIndex || !isTable(descriptor)) return
    const values = columns[index] ?? []
    series.push({
      metric: metricName(descriptor),
      points: values.map((value, row): [number | null, number | null] => [timeMs(times[row]), asNumber(value)]),
    })
  })
  return series
}

/** `{ results: { A: { frames: [...] } } }` flattened to one series per value field. */
export function flattenFrames(json: unknown): { series: GrafanaSeries[] } {
  const series: GrafanaSeries[] = []
  if (!isTable(json)) return { series }
  const results = json['results']
  if (!isTable(results)) return { series }
  for (const result of Object.values(results)) {
    if (!isTable(result)) continue
    const error = result['error']
    if (typeof error === 'string' && error !== '') throw new OpsError(error, 'upstream')
    const frames = result['frames']
    if (!Array.isArray(frames)) continue
    for (const frame of frames) series.push(...seriesOfFrame(frame))
  }
  return { series }
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

const healthVerb: CommandNode = {
  summary: 'Grafana database and version',
  usage: [
    'crafty grafana health [options]',
    '',
    'Probes `GET /api/health` and prints the database status and version the',
    'server reports. Nothing is written.',
    '',
    'Options:',
    '  --target <name>  Target to use (default: settings.default_targets.grafana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  run: async (ctx) => {
    const { target, settings } = grafanaTarget(ctx)
    const response = await httpRequest(target, { method: 'GET', path: '/api/health' }, settings)
    emitResult(ctx, response.json ?? null, { truncated: false })
    return 0
  },
}

const datasourcesVerb: CommandNode = {
  summary: 'Data sources Grafana can query',
  usage: [
    'crafty grafana datasources [options]',
    '',
    'Lists `GET /api/datasources` as one row per datasource: uid, name, type,',
    'url and whether it is the default. Read-only.',
    '',
    'Options:',
    '  --target <name>  Target to use (default: settings.default_targets.grafana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  run: async (ctx) => {
    const { target, settings } = grafanaTarget(ctx)
    const response = await httpRequest(target, { method: 'GET', path: '/api/datasources' }, settings)
    const list = Array.isArray(response.json) ? response.json.filter(isTable) : []
    const rows = list.map((datasource) => ({
      uid: datasource['uid'] ?? null,
      name: datasource['name'] ?? null,
      type: datasource['type'] ?? null,
      url: datasource['url'] ?? null,
      is_default: datasource['isDefault'] === true,
    }))
    return emitRows(ctx, rows, settings, ['uid', 'name', 'type', 'url', 'is_default'])
  },
}

const dashboardsVerb: CommandNode = {
  summary: 'Search dashboards',
  usage: [
    'crafty grafana dashboards [options]',
    '',
    'Searches dashboards through `GET /api/search?type=dash-db`. --query narrows',
    'the search the way the Grafana UI does.',
    '',
    'Options:',
    '  --query <text>   Only dashboards matching this text',
    '  --target <name>  Target to use (default: settings.default_targets.grafana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'query', type: 'string' }],
  run: async (ctx) => {
    const { target, settings } = grafanaTarget(ctx)
    const query = option(ctx.values, 'query')
    const response = await httpRequest(
      target,
      {
        method: 'GET',
        path: '/api/search',
        query: { type: 'dash-db', ...(query === undefined ? {} : { query }) },
      },
      settings,
    )
    const list = Array.isArray(response.json) ? response.json.filter(isTable) : []
    const rows = list.map((dashboard) => ({
      uid: dashboard['uid'] ?? null,
      title: dashboard['title'] ?? null,
      url: dashboard['url'] ?? null,
      folder: dashboard['folderTitle'] ?? null,
      tags: Array.isArray(dashboard['tags']) ? dashboard['tags'].map(String).join(',') : null,
    }))
    return emitRows(ctx, rows, settings, ['uid', 'title', 'url', 'folder', 'tags'])
  },
}

const dashboardVerb: CommandNode = {
  summary: 'One dashboard, by uid',
  usage: [
    'crafty grafana dashboard <uid> [options]',
    '',
    'Fetches `GET /api/dashboards/uid/<uid>` and prints the dashboard document',
    'and its metadata as they came back. Read-only.',
    '',
    'Options:',
    '  --target <name>  Target to use (default: settings.default_targets.grafana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  run: async (ctx) => {
    const { target, settings } = grafanaTarget(ctx)
    const uid = ctx.positionals[0]
    if (uid === undefined) throw usageError('a dashboard uid is required', 'see `crafty grafana dashboards`')
    if (ctx.positionals.length > 1) {
      throw usageError(`this verb takes one uid, got ${ctx.positionals.length}`, `did you mean \`crafty grafana dashboard ${uid}\`?`)
    }
    const response = await httpRequest(target, { method: 'GET', path: `/api/dashboards/uid/${encodeURIComponent(uid)}` }, settings)
    emitResult(ctx, response.json ?? null, { truncated: false })
    return 0
  },
}

const annotationsVerb: CommandNode = {
  summary: 'Annotations in a time window',
  usage: [
    'crafty grafana annotations [options]',
    '',
    'Lists `GET /api/annotations` for the window between --from and --to, using',
    'the same time grammar as every other verb (`2h`, `7d`, an ISO timestamp).',
    'The default window is the last hour. Read-only.',
    '',
    'Options:',
    '  --from <when>    Start of the window (default 1h)',
    '  --to <when>      End of the window (default now)',
    '  --target <name>  Target to use (default: settings.default_targets.grafana)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [
    { name: 'from', type: 'string' },
    { name: 'to', type: 'string' },
  ],
  run: async (ctx) => {
    const { target, settings } = grafanaTarget(ctx)
    const from = parseSince(option(ctx.values, 'from') ?? '1h')
    const to = parseUntil(option(ctx.values, 'to'))
    const response = await httpRequest(
      target,
      { method: 'GET', path: '/api/annotations', query: { from: from.ms, to: to.ms } },
      settings,
    )
    const list = Array.isArray(response.json) ? response.json.filter(isTable) : []
    const rows = list.map((annotation) => ({
      id: annotation['id'] ?? null,
      time: annotation['time'] ?? null,
      time_end: annotation['timeEnd'] ?? null,
      text: annotation['text'] ?? null,
      tags: Array.isArray(annotation['tags']) ? annotation['tags'].map(String).join(',') : null,
    }))
    return emitRows(ctx, rows, settings, ['id', 'time', 'time_end', 'text', 'tags'])
  },
}

const queryVerb: CommandNode = {
  summary: 'Run a datasource query through Grafana',
  usage: [
    'crafty grafana query --datasource <uid|name> --expr <promql> [options]',
    '',
    'Runs `POST /api/ds/query` against one datasource. --datasource accepts a',
    'uid or a display name; a name is resolved through /api/datasources first.',
    'The response frames are flattened to `{ series: [{ metric, points }] }`,',
    'where each point is a `[timestamp, value]` pair. Read-only, so no --yes.',
    '',
    'Options:',
    '  --datasource <uid|name>  Datasource to query (required)',
    '  --expr <promql>          Query expression (required)',
    '  --since <when>           Start of the window (default 1h)',
    '  --step <duration>        Point interval, e.g. 30s (default 60s)',
    '  --instant                Instant query instead of a range query',
    '  --target <name>          Target to use (default: settings.default_targets.grafana)',
    '  --json                   Print the envelope',
    '  -h, --help               Show this message',
  ],
  options: [
    { name: 'datasource', type: 'string' },
    { name: 'expr', type: 'string' },
    { name: 'since', type: 'string' },
    { name: 'step', type: 'string' },
    { name: 'instant', type: 'boolean' },
  ],
  run: async (ctx) => {
    const { target, settings } = grafanaTarget(ctx)
    const datasource = required(ctx, 'datasource')
    const expr = required(ctx, 'expr')
    const instant = flag(ctx.values, 'instant')
    const now = Date.now()
    const since = parseSince(option(ctx.values, 'since') ?? '1h', now)
    const stepMs = parseStep(option(ctx.values, 'step') ?? '60s')
    const uid = await resolveDatasourceUid(target, datasource, settings)
    const windowMs = Math.max(0, now - since.ms)
    const body = {
      queries: [
        {
          refId: 'A',
          datasource: { uid },
          expr,
          instant,
          range: true,
          // Grafana needs the interval and point budget for a range query;
          // --step feeds both, so the query actually samples at the asked rate.
          intervalMs: stepMs,
          maxDataPoints: Math.max(1, Math.ceil(windowMs / stepMs)),
        },
      ],
      from: toGrafanaFrom(since, now),
      to: 'now',
    }
    const response = await httpRequest(target, { method: 'POST', path: '/api/ds/query', body, retryable: true }, settings)
    const { series } = flattenFrames(response.json)
    const kept = series.slice(0, settings.max_rows)
    emitResult(ctx, { series: kept }, { truncated: kept.length < series.length })
    return 0
  },
}

export default {
  name: 'grafana',
  summary: 'Grafana dashboards, data sources and datasource queries',
  source: 'grafana',
  options: [{ name: 'target', type: 'string' }],
  commands: {
    health: healthVerb,
    datasources: datasourcesVerb,
    dashboards: dashboardsVerb,
    dashboard: dashboardVerb,
    annotations: annotationsVerb,
    query: queryVerb,
  },
} satisfies CommandModule
