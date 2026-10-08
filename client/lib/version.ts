import { join } from 'node:path'
import manifest from '../package.json' with { type: 'json' }

/** The client application's version, independent of the framework package. */
export const VERSION: string = manifest.version ?? 'unknown'

/**
 * Read the client manifest next to lib; if it is missing or has no string
 * version, use the imported value.
 */
export async function readVersion(): Promise<string> {
  const file = Bun.file(join(import.meta.dir, '..', 'package.json'))
  if (!(await file.exists())) return VERSION
  const parsed: unknown = await file.json()
  if (parsed === null || typeof parsed !== 'object' || !('version' in parsed)) return VERSION
  return typeof parsed.version === 'string' ? parsed.version : VERSION
}
