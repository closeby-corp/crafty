import { emitResult, type CommandModule } from 'crafty'
import { readVersion } from '../lib/manifest.ts'

/**
 * One handler, two renderings: `emitResult` prints the envelope under `--json`
 * and the plain string otherwise.
 */
export default {
  name: 'version',
  summary: 'Print this client version and the Bun it runs on',
  mcp: 'read',
  run: async (ctx) => {
    const version = await readVersion()
    if (!ctx.json) {
      emitResult(ctx, `${version} (bun ${Bun.version}, ${process.platform}-${process.arch})`)
      return
    }
    emitResult(ctx, { version, bun: Bun.version, platform: process.platform, arch: process.arch })
  },
} satisfies CommandModule
