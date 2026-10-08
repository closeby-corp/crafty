import { usageError } from 'crafty'

/** One argument the way a shell would pass it: single-quoted, `'` escaped. */
export function shellQuote(argv: string[]): string {
  return argv
    .map((arg) => (arg === '' ? "''" : `'${arg.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

/**
 * The inverse of `shellQuote`, for recipe `run:` lines: whitespace splits,
 * quotes group, and a backslash escapes the next character outside single
 * quotes. `{{...}}` is ordinary text here - substitution happens later, per
 * argument, so a parameter holding spaces stays one argument.
 */
export function splitArgv(line: string): string[] {
  const args: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!

    if (char === "'" && quote !== '"') {
      if (quote === "'") quote = null
      else quote = "'"
      started = true
      continue
    }

    if (char === '"' && quote !== "'") {
      if (quote === '"') quote = null
      else quote = '"'
      started = true
      continue
    }

    if (char === '\\' && quote !== "'") {
      const next = line[index + 1]
      if (next === undefined) {
        current += '\\'
        started = true
        continue
      }
      if (quote === '"') {
        // Only the escapes a double-quoted string can carry survive as their
        // meaning; anything else keeps its backslash, as in a shell.
        const mapped = next === 'n' ? '\n' : next === 't' ? '\t' : next
        if (next === '"' || next === '\\' || next === 'n' || next === 't') {
          current += mapped
          index += 1
          started = true
          continue
        }
        current += '\\'
        started = true
        continue
      }
      current += next
      index += 1
      started = true
      continue
    }

    if (quote === null && /\s/.test(char)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }

    current += char
    started = true
  }

  if (quote !== null) throw usageError(`unterminated ${quote === '"' ? 'double' : 'single'} quote in "${line}"`)
  if (started) args.push(current)
  return args
}
