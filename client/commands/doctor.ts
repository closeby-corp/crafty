/**
 * `ops doctor`: one probe per configured source. The point is that a wrong
 * credential is told apart from an unreachable host and from a service that
 * answered something unexpected, before any verb is trusted.
 */
import { OpsError } from 'crafty'
import { emitResult, option, writeErr } from 'crafty'
import type { Ctx } from 'crafty'
import type { CommandModule } from 'crafty'
import { probeSshHost, probeTarget, type ProbeResult } from '../lib/probes.ts'
import { loadConfig } from '../lib/targets.ts'
import type { Target, TargetFile } from '../lib/targets.ts'
import { mapWithLimit } from './ssh.ts'

const CONCURRENCY = 4

export function targetsToProbe(file: TargetFile, wanted?: string): Array<{ name: string; kind: string; target?: Target }> {
  const entries = [
    ...file.ssh.hosts.map((host) => ({ name: host, kind: 'ssh' })),
    ...[...file.targets.values()].map((target) => ({ name: target.name, kind: target.kind, target })),
  ]
  if (wanted === undefined) return entries
  const matched = entries.filter((entry) => entry.name === wanted)
  if (matched.length === 0) {
    throw new OpsError(`no target named "${wanted}"`, 'not-found', {
      hint: `configured: ${entries.map((entry) => entry.name).join(', ') || 'none'}`,
    })
  }
  return matched
}

async function runProbes(ctx: Ctx): Promise<ProbeResult[]> {
  const file = loadConfig()
  const settings = file.settings
  const entries = targetsToProbe(file, option(ctx.values, 'target'))
  return await mapWithLimit(entries, CONCURRENCY, async (entry) =>
    entry.target === undefined
      ? await probeSshHost(entry.name, settings)
      : await probeTarget(entry.target, settings),
  )
}

export default {
  name: 'doctor',
  summary: 'Probe every configured source and report what works',
  usage: [
    'crafty doctor [options]',
    '',
    'One probe per target, plus one per host under [ssh]: the cheapest call that',
    'proves reachability and authorisation. Each row is',
    '{ target, kind, status: ok|auth|unreachable|error, detail, duration_ms }.',
    'Exit 1 if any probe failed, 0 if all of them answered.',
    '',
    'Options:',
    '  --target <name>  Probe only this target (or ssh host)',
    '  --json           Print the envelope',
    '  -v, --verbose    Trace the requests',
    '  -h, --help       Show this message',
  ],
  source: 'doctor',
  options: [{ name: 'target', type: 'string' }],
  run: async (ctx) => {
    const results = await runProbes(ctx)
    const failed = results.filter((result) => result.status !== 'ok')
    emitResult(ctx, results, { columns: ['target', 'kind', 'status', 'detail', 'duration_ms'], truncated: false })
    if (!ctx.json && ctx.format === 'auto') {
      const counts = results.reduce<Record<string, number>>((tally, result) => {
        tally[result.status] = (tally[result.status] ?? 0) + 1
        return tally
      }, {})
      writeErr(`${results.length} probe(s): ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}\n`)
      if (failed.length > 0) writeErr(`fix the ${failed.length} failing target(s), then run this again\n`)
    }
    return failed.length === 0 ? 0 : 1
  },
} satisfies CommandModule
