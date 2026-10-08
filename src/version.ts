import { join } from 'node:path'
import manifest from '../package.json' with { type: 'json' }

/** The version imported from the runtime source tree's manifest. */
export const VERSION: string = manifest.version ?? 'unknown'

/**
 * Read the manifest next to the runtime source. Both entrypoints use this tree;
 * if the manifest is missing or has no string version, use the imported value.
 */
export async function readVersion(): Promise<string> {
  const file = Bun.file(join(import.meta.dir, '..', 'package.json'))
  if (!(await file.exists())) return VERSION
  const parsed: unknown = await file.json()
  if (parsed === null || typeof parsed !== 'object' || !('version' in parsed)) return VERSION
  return typeof parsed.version === 'string' ? parsed.version : VERSION
}
