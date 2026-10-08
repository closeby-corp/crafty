import { describe, expect, test } from 'bun:test'
import { levelClause, levelField, textClause, textFields } from '../src/fields.ts'

describe('the field catalog', () => {
  test('a target that says nothing gets the documented defaults', () => {
    // logback: `level` returns nothing, `log_level` is the field that works.
    expect(levelField('kibana', {})).toBe('log_level')
    expect(textFields('kibana', {})).toEqual(['message'])
    // EKS: the line text is in `log`, and the client searches these three.
    expect(levelField('opensearch', {})).toBe('level')
    expect(textFields('opensearch', {})).toEqual(['log', 'message', 'msg'])
  })

  test('what the file says wins', () => {
    expect(levelField('kibana', { level_field: 'severity' })).toBe('severity')
    expect(textFields('opensearch', { text_fields: ['body'] })).toEqual(['body'])
    expect(textFields('kibana', { text_fields: [] })).toEqual([])
  })

  test('a source with no level field at all is named as such', () => {
    // `kibana` and `opensearch` are the only kinds with a catalog today.
    expect(levelField('prometheus', {})).toBeUndefined()
  })
})

describe('the clauses a verb builds', () => {
  test('--level matches the field this source publishes', () => {
    expect(levelClause('log_level', 'ERROR')).toEqual({ match: { log_level: 'ERROR' } })
  })

  test('--text spreads across the fields only when there is more than one', () => {
    expect(textClause(['message'], 'dispatchDe')).toEqual({ match: { message: 'dispatchDe' } })
    expect(textClause(['log', 'message', 'msg'], 'dispatchDe')).toEqual({
      multi_match: { query: 'dispatchDe', fields: ['log', 'message', 'msg'] },
    })
  })
})
