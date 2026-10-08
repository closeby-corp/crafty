import { describe, expect, test } from 'bun:test'
import { splitArgv, shellQuote } from '../lib/argv.ts'
import { OpsError } from 'crafty'

describe('shellQuote', () => {
  test('quotes every element', () => {
    expect(shellQuote(['docker', 'ps'])).toBe(`'docker' 'ps'`)
    expect(shellQuote([])).toBe('')
    expect(shellQuote([''])).toBe(`''`)
    expect(shellQuote(['a b'])).toBe(`'a b'`)
  })

  test("survives a single quote by closing and reopening the string", () => {
    expect(shellQuote([`it's`])).toBe(`'it'\\''s'`)
    expect(shellQuote([`--format`, `'{{.Names}}'`])).toBe(`'--format' ''\\''{{.Names}}'\\'''`)
  })
})

describe('splitArgv', () => {
  test('splits on whitespace and honours quotes', () => {
    const cases: [string, string[]][] = [
      ['ssh run hostname', ['ssh', 'run', 'hostname']],
      ['  spaced   out  ', ['spaced', 'out']],
      ['', []],
      [`docker logs "a b"`, ['docker', 'logs', 'a b']],
      [`docker logs 'a b'`, ['docker', 'logs', 'a b']],
      [`x -- ''`, ['x', '--', '']],
      ['{{params.host}}', ['{{params.host}}']],
      ['a {{p.x}} b', ['a', '{{p.x}}', 'b']],
      [`--format '{{.Names}}\\t{{.Image}}'`, ['--format', '{{.Names}}\\t{{.Image}}']],
    ]
    for (const [input, expected] of cases) {
      expect(splitArgv(input), input).toEqual(expected)
    }
  })

  test('escape sequences: backslash outside quotes, C escapes inside double quotes', () => {
    expect(splitArgv('a\\ b')).toEqual(['a b'])
    expect(splitArgv('a\\\\b')).toEqual(['a\\b'])
    expect(splitArgv('"a\\nb"')).toEqual(['a\nb'])
    expect(splitArgv('"a\\tb"')).toEqual(['a\tb'])
    expect(splitArgv('"a\\"b"')).toEqual(['a"b'])
    expect(splitArgv('"a\\qb"')).toEqual(['a\\qb'])
    expect(splitArgv("'a\\nb'")).toEqual(['a\\nb'])
  })

  test('round-trips through shellQuote', () => {
    const argv = ['ssh', 'run', 'uq-observability', '--', `docker logs "a b"`]
    expect(splitArgv(shellQuote(argv))).toEqual(argv)
  })

  test('an unterminated quote is a usage error', () => {
    expect(() => splitArgv(`docker logs "a b`)).toThrow(OpsError)
    expect(() => splitArgv(`docker logs 'a b`)).toThrow(OpsError)
    try {
      splitArgv(`docker logs "a b`)
    } catch (error) {
      expect((error as OpsError).kind).toBe('usage')
      expect((error as OpsError).message).toContain('unterminated double quote')
    }
  })
})
