import { describe, expect, test } from 'bun:test'
import { OpsError } from 'crafty'
import { formatDuration, parseSince, parseUntil, pickStep, toGrafanaFrom, toPromRange } from '../lib/time.ts'

const NOW = Date.parse('2026-10-07T12:00:00.000Z')

describe('parseSince', () => {
  test('relative windows count back from now', () => {
    const cases: [string, string][] = [
      ['90s', '2026-10-07T11:58:30.000Z'],
      ['15m', '2026-10-07T11:45:00.000Z'],
      ['12h', '2026-10-07T00:00:00.000Z'],
      ['7d', '2026-09-30T12:00:00.000Z'],
      ['2w', '2026-09-23T12:00:00.000Z'],
      ['300', '2026-10-07T11:55:00.000Z'],
    ]
    for (const [input, expected] of cases) {
      expect(parseSince(input, NOW).iso, input).toBe(expected)
    }
  })

  test('ISO-8601 timestamps and epoch seconds are absolute', () => {
    expect(parseSince('2026-10-01T00:00:00Z', NOW).iso).toBe('2026-10-01T00:00:00.000Z')
    expect(parseSince('2026-10-01', NOW).iso).toBe('2026-10-01T00:00:00.000Z')
    expect(parseSince('1760000000', NOW).seconds).toBe(1760000000)
    expect(parseSince('1760000000', NOW).iso).toBe(new Date(1760000000 * 1000).toISOString())
  })

  test('reports the window as milliseconds, ISO text and epoch seconds', () => {
    expect(parseSince('1h', NOW)).toEqual({
      ms: NOW - 3_600_000,
      iso: '2026-10-07T11:00:00.000Z',
      seconds: Math.floor((NOW - 3_600_000) / 1000),
    })
  })

  test('an unreadable time is a usage error that names the forms', () => {
    expect(() => parseSince('yesterday', NOW)).toThrow(OpsError)
    try {
      parseSince('yesterday', NOW)
    } catch (error) {
      expect((error as OpsError).kind).toBe('usage')
      expect((error as OpsError).message).toContain('yesterday')
      expect((error as OpsError).hint).toContain('15m')
    }
  })
})

describe('parseUntil', () => {
  test('defaults to now', () => {
    expect(parseUntil(undefined, NOW).ms).toBe(NOW)
    expect(parseUntil('', NOW).ms).toBe(NOW)
  })

  test('reads a relative window the same way --since does', () => {
    expect(parseUntil('30m', NOW).iso).toBe('2026-10-07T11:30:00.000Z')
    expect(parseUntil('2026-10-07T11:00:00Z', NOW).iso).toBe('2026-10-07T11:00:00.000Z')
  })
})

describe('formatDuration', () => {
  test('picks a unit an operator can read', () => {
    expect(formatDuration(45)).toBe('45ms')
    expect(formatDuration(1_250)).toBe('1.3s')
    expect(formatDuration(125_000)).toBe('2m5s')
    expect(formatDuration(7_380_000)).toBe('2h3m')
    expect(formatDuration(200_000_000)).toBe('2d7h')
  })
})

describe('toPromRange', () => {
  test('reports epoch seconds and a step the server will accept', () => {
    expect(toPromRange(parseSince('1h', NOW), parseUntil(undefined, NOW))).toEqual({
      start: '1791370800',
      end: '1791374400',
      step: '5',
    })
  })

  test('an explicit step wins', () => {
    expect(toPromRange(parseSince('1h', NOW), parseUntil(undefined, NOW), '30s').step).toBe('30s')
  })

  test('step grows with the window so a query stays small', () => {
    expect(pickStep(60_000)).toBe(1)
    expect(pickStep(3_600_000)).toBe(5)
    expect(pickStep(86_400_000)).toBe(120)
  })
})

describe('toGrafanaFrom', () => {
  test('renders the window Grafana expects', () => {
    expect(toGrafanaFrom(parseSince('1h', NOW), NOW)).toBe('now-3600s')
    expect(toGrafanaFrom(parseUntil(undefined, NOW), NOW)).toBe('now')
  })
})
