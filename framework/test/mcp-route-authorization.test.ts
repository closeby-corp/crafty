import { describe, expect, test } from 'bun:test'
import { prepareCommand } from '../src/command.ts'
import { assertNoStaticRouteShadow } from '../src/plugins/mcp-route-guard.ts'

describe('MCP dynamic route authorization', () => {
  const command = prepareCommand('fixture', { commands: {
    ':item': { run() {} },
    admin: { mcp: 'hidden', run() {} },
    operations: { aliases: ['ops'], mcp: 'write', run() {} },
  } })

  test('rejects dynamic values that dispatch to hidden or write static siblings', () => {
    expect(() => assertNoStaticRouteShadow(command.definition, 'item', 'admin')).toThrow(/static command or alias/)
    expect(() => assertNoStaticRouteShadow(command.definition, 'item', 'ops')).toThrow(/static command or alias/)
  })

  test('preserves values that resolve through the dynamic route', () => {
    expect(() => assertNoStaticRouteShadow(command.definition, 'item', 'customer-42')).not.toThrow()
  })
})
