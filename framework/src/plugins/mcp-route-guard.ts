import type { CommandNode } from '../command.ts'
import { usageError } from '../errors.ts'

/** Prevent a dynamic MCP argument from being reparsed as a static CLI route. */
export function assertNoStaticRouteShadow(parent: CommandNode, parameter: string, value: string): void {
  const shadowsStaticRoute = Object.entries(parent.commands ?? {}).some(([key, child]) => !key.startsWith(':')
    && (key === value || (typeof child !== 'function' && child.aliases?.includes(value))))
  if (shadowsStaticRoute) {
    throw usageError(`params.${parameter} cannot match a static command or alias at this route level`)
  }
}
