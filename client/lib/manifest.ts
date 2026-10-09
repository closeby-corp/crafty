import { join } from 'node:path'
import manifest from '../package.json' with { type: 'json' }

/** The version in the manifest next to this source; a fallback for a missing file. */
export const VERSION: string = manifest.version ?? 'unknown'

/**
 * The version of this client's manifest as it is on disk. Helpers like this one
 * live outside `commands/`, so discovery never turns them into commands.
 */
export async function readVersion(): Promise<string> {
  const file = Bun.file(join(import.meta.dir, '..', 'package.json'))
  if (!(await file.exists())) return VERSION
  const parsed: unknown = await file.json()
  if (parsed === null || typeof parsed !== 'object' || !('version' in parsed)) return VERSION
  const version = (parsed as { version?: unknown }).version
  return typeof version === 'string' ? version : VERSION
}
