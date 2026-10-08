import { emitResult } from 'crafty'
import { readVersion, VERSION } from '../lib/version.ts'
import type { CommandModule } from 'crafty'

export default {
  name: 'version',
  summary: 'Print the version this build came from',
  usage: [
    'crafty version [options]',
    '',
    'The version in the manifest, and the Bun it is running on. Both are in the',
    'envelope so a bug report can name them.',
    '',
    'Options:',
    '  --json      Print the envelope',
    '  -h, --help  Show this message',
  ],
  source: 'version',
  run: async (ctx) => {
    const version = await readVersion()
    if (!ctx.json) {
      emitResult(ctx, `${version} (bun ${Bun.version}, ${process.platform}-${process.arch})`, { truncated: false })
      return 0
    }
    emitResult(
      ctx,
      { version, built_as: VERSION, bun: Bun.version, platform: process.platform, arch: process.arch },
      { truncated: false },
    )
    return 0
  },
} satisfies CommandModule
