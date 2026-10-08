/**
 * `crafty prometheus`: the read-only half of the Prometheus HTTP API, with the
 * usual envelope. Every verb is a GET, so nothing here needs the write gate.
 */
import { OpsError, usageError } from 'crafty'
import { httpRequest } from '../lib/http.ts'
import { emitResult, option } from 'crafty'
import type { Ctx, Meta } from 'crafty'
import type { CommandModule, CommandNode } from 'crafty'
import { loadConfig, requireTarget } from '../lib/targets.ts'
import type { PrometheusTarget, Settings } from '../lib/targets.ts'
import { parseSince, parseUntil, toPromRange } from '../lib/time.ts'
import { isTable } from '../lib/values.ts'
import type { HttpResponse } from '../lib/http.ts'

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

function prometheusTarget(ctx: Ctx): PrometheusTarget {
  const target = requireTarget('prometheus', option(ctx.values, 'target'))
  if (target.kind !== 'prometheus') {
    throw new OpsError(`target "${target.name}" is a ${target.kind} target`, 'config', {
      hint: 'prometheus verbs need a target with kind = "prometheus"',
    })
  }
  ctx.target = target.name
  return target
}

/**
 * Every Prometheus response is `{status, data}`; a non-`success` status is an
 * upstream failure even when the HTTP call itself was a 200.
 */
function promData(response: HttpResponse): unknown {
  const body = isTable(response.json) ? response.json : {}
  if (body['status'] !== 'success') {
    const type = typeof body['errorType'] === 'string' && body['errorType'] !== '' ? body['errorType'] : 'error'
    const detail =
      typeof body['error'] === 'string' && body['error'] !== ''
        ? body['error']
        : response.text.trim().slice(0, 500) || 'the server answered without a message'
    throw new OpsError(`${type}: ${detail}`, 'upstream')
  }
  return body['data']
}

/** Row sets honour settings.max_rows like every other verb; other shapes pass through. */
function emitProm(ctx: Ctx, data: unknown, meta: Partial<Meta> = {}): number {
  const max = loadConfig().settings.max_rows
  if (
    Array.isArray(data) &&
    data.length > max &&
    data.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
  ) {
    emitResult(ctx, data.slice(0, max), { ...meta, truncated: true })
    return 0
  }
  emitResult(ctx, data, { ...meta, truncated: false })
  return 0
}

async function get(
  target: PrometheusTarget,
  settings: Settings,
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  const request = { method: 'GET', path, ...(query === undefined ? {} : { query }) }
  const response = await httpRequest(target, request, settings)
  return promData(response)
}

/* ------------------------------------------------------------------ *
 * Verbs
 * ------------------------------------------------------------------ */

const queryVerb: CommandNode = {
  summary: 'Run an instant PromQL query',
  usage: [
    'crafty prometheus query <expr> [options]',
    '',
    'Runs one instant query (`GET /api/v1/query`) and prints `data.result` as',
    'rows. With --at the expression is evaluated at that instant; without it, at',
    "the server's now. Read-only.",
    '',
    'Options:',
    '  --at <when>      Evaluate at this instant (default now)',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [
    { name: 'at', type: 'string' },
    { name: 'target', type: 'string' },
  ],
  run: async (ctx) => {
    const expr = ctx.positionals[0]
    if (expr === undefined) throw usageError('an expression is required', "as in `crafty prometheus query 'up'`")
    const target = prometheusTarget(ctx)
    const at = option(ctx.values, 'at')
    const data = await get(target, loadConfig().settings, '/api/v1/query', {
      query: expr,
      ...(at === undefined ? {} : { time: String(parseSince(at).seconds) }),
    })
    const resultType = isTable(data) && typeof data['resultType'] === 'string' ? data['resultType'] : undefined
    const meta = resultType === undefined ? {} : { result_type: resultType }
    return emitProm(ctx, isTable(data) ? data['result'] : data, meta)
  },
}

const rangeVerb: CommandNode = {
  summary: 'Run a PromQL range query',
  usage: [
    'crafty prometheus range <expr> [options]',
    '',
    'Runs a range query (`GET /api/v1/query_range`) over a time window and prints',
    '`data.result` as rows. The window runs from --since (or --start) to --end and',
    'defaults to the last hour; the step is chosen from the window unless --step',
    'is given. Read-only.',
    '',
    'Options:',
    '  --since <when>   Start of the window (default 1h)',
    '  --start <when>   Start of the window, same as --since',
    '  --end <when>     End of the window (default now)',
    '  --step <dur>     Resolution step, e.g. 60s (default chosen from the window)',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [
    { name: 'since', type: 'string' },
    { name: 'start', type: 'string' },
    { name: 'end', type: 'string' },
    { name: 'step', type: 'string' },
    { name: 'target', type: 'string' },
  ],
  run: async (ctx) => {
    const expr = ctx.positionals[0]
    if (expr === undefined) {
      throw usageError('an expression is required', "as in `crafty prometheus range 'up' --since 1h`")
    }
    const target = prometheusTarget(ctx)
    const since = option(ctx.values, 'since')
    const start = option(ctx.values, 'start')
    if (since !== undefined && start !== undefined) throw usageError('give --since or --start, not both')
    const window = toPromRange(
      parseSince(start ?? since ?? '1h'),
      parseUntil(option(ctx.values, 'end')),
      option(ctx.values, 'step'),
    )
    const data = await get(target, loadConfig().settings, '/api/v1/query_range', {
      query: expr,
      start: window.start,
      end: window.end,
      step: window.step,
    })
    const resultType = isTable(data) && typeof data['resultType'] === 'string' ? data['resultType'] : undefined
    const meta = resultType === undefined ? {} : { result_type: resultType }
    return emitProm(ctx, isTable(data) ? data['result'] : data, meta)
  },
}

const labelsVerb: CommandNode = {
  summary: 'List the label names a server knows',
  usage: [
    'crafty prometheus labels [options]',
    '',
    '`GET /api/v1/labels`, one row per label name.',
    '',
    'Options:',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => {
    const target = prometheusTarget(ctx)
    const data = await get(target, loadConfig().settings, '/api/v1/labels')
    return emitProm(ctx, Array.isArray(data) ? data.map((label) => ({ label })) : data, { columns: ['label'] })
  },
}

const labelVerb: CommandNode = {
  summary: 'List the values of one label',
  usage: [
    'crafty prometheus label <name> [options]',
    '',
    '`GET /api/v1/label/<name>/values`, one row per value.',
    '',
    'Options:',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => {
    const name = ctx.positionals[0]
    if (name === undefined) throw usageError('a label name is required', "as in `crafty prometheus label job`")
    const target = prometheusTarget(ctx)
    const data = await get(target, loadConfig().settings, `/api/v1/label/${encodeURIComponent(name)}/values`)
    return emitProm(ctx, Array.isArray(data) ? data.map((value) => ({ value })) : data, { columns: ['value'] })
  },
}

const seriesVerb: CommandNode = {
  summary: 'Find the series matching a selector',
  usage: [
    'crafty prometheus series --match <selector> [options]',
    '',
    '`GET /api/v1/series`, one row per matching series (its label set). The',
    'selector is passed verbatim, so quote it: --match \'up{job="prometheus"}\'.',
    '',
    'Options:',
    '  --match <sel>    Series selector (required)',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [
    { name: 'match', type: 'string' },
    { name: 'target', type: 'string' },
  ],
  run: async (ctx) => {
    const match = option(ctx.values, 'match')
    if (match === undefined || match === '') {
      throw usageError('--match is required', `a selector, as in --match 'up{job="prometheus"}'`)
    }
    const target = prometheusTarget(ctx)
    const data = await get(target, loadConfig().settings, '/api/v1/series', { 'match[]': match })
    return emitProm(ctx, data)
  },
}

const targetsVerb: CommandNode = {
  summary: 'List the scrape targets',
  usage: [
    'crafty prometheus targets [options]',
    '',
    '`GET /api/v1/targets`, with the active and dropped targets as the server',
    'reports them. Read-only.',
    '',
    'Options:',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => emitProm(ctx, await get(prometheusTarget(ctx), loadConfig().settings, '/api/v1/targets')),
}

const rulesVerb: CommandNode = {
  summary: 'List alerting and recording rules',
  usage: [
    'crafty prometheus rules [options]',
    '',
    '`GET /api/v1/rules`, with the rule groups the server reports. Read-only.',
    '',
    'Options:',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => emitProm(ctx, await get(prometheusTarget(ctx), loadConfig().settings, '/api/v1/rules')),
}

const alertsVerb: CommandNode = {
  summary: 'List the active alerts',
  usage: [
    'crafty prometheus alerts [options]',
    '',
    '`GET /api/v1/alerts`, one row per alert the server is firing or pending.',
    '',
    'Options:',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => emitProm(ctx, await get(prometheusTarget(ctx), loadConfig().settings, '/api/v1/alerts')),
}

const buildVerb: CommandNode = {
  summary: 'Show the server build information',
  usage: [
    'crafty prometheus build [options]',
    '',
    '`GET /api/v1/status/buildinfo`: version, revision, branch and build time.',
    'Read-only.',
    '',
    'Options:',
    '  --target <name>  Target to use (default settings.default_targets.prometheus)',
    '  --json           Print the envelope',
    '  -h, --help       Show this message',
  ],
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => {
    const data = await get(prometheusTarget(ctx), loadConfig().settings, '/api/v1/status/buildinfo')
    return emitProm(ctx, data)
  },
}

export default {
  name: 'prometheus',
  aliases: ['prom'],
  summary: 'Query and inspect a Prometheus server over its HTTP API',
  source: 'prometheus',
  commands: {
    query: queryVerb,
    range: rangeVerb,
    labels: labelsVerb,
    label: labelVerb,
    series: seriesVerb,
    targets: targetsVerb,
    rules: rulesVerb,
    alerts: alertsVerb,
    build: buildVerb,
  },
} satisfies CommandModule
