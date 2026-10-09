import { describe, expect, test } from 'bun:test'
import { redactString, registerSecret } from '../src/log.ts'

describe('short registered secrets', () => {
  test('redacts every non-empty registered value and masks longer overlaps first', () => {
    const short = 'q7'
    const longer = 'q7-private-fixture'
    registerSecret(short)
    registerSecret(longer)
    registerSecret('')
    registerSecret(null)
    registerSecret(undefined)

    expect(redactString(`short=${short}; longer=${longer}`))
      .toBe('short=[redacted]; longer=[redacted]')
  })
})
