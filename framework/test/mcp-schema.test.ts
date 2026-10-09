import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

const frameworkDirectory = resolve(import.meta.dir, '..')

function moduleUrl(path: string): string {
  return new URL(path, import.meta.url).href
}

function parseJsonRpcResponse(text: string): Record<string, unknown> {
  const json = text.startsWith('{')
    ? text
    : text.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice('data:'.length).trim()
  if (!json) throw new Error(`MCP response did not contain a JSON-RPC message: ${text}`)
  return JSON.parse(json) as Record<string, unknown>
}

test('advertises __proto__ as a dynamic route parameter in the MCP input schema', async () => {
  const childSource = `
    import { setCommands, run } from ${JSON.stringify(moduleUrl('../src/cli.ts'))};
    import { prepareCommand } from ${JSON.stringify(moduleUrl('../src/command.ts'))};
    import { createMcpPlugin } from ${JSON.stringify(moduleUrl('../src/plugins/mcp.ts'))};

    delete process.env.CRAFTY_MCP_TOKEN;
    delete process.env.CRAFTY_MCP_ALLOW_WRITES;
    setCommands([
      prepareCommand('prototype', {
        name: 'prototype',
        commands: {
          ':__proto__': { summary: 'Route with a prototype-spelled parameter', mcp: 'read', run() {} },
        },
      }),
      prepareCommand('mcp', createMcpPlugin()),
    ]);
    await run(['mcp', 'serve', '--port', '0']);
  `
  const child = Bun.spawn([process.execPath, '-e', childSource], {
    cwd: frameworkDirectory,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const startupDeadline = setTimeout(() => child.kill('SIGTERM'), 15_000)
  const stdoutReader = child.stdout.getReader()
  const stderrReader = child.stderr.getReader()
  let stderr = ''
  const drainStderr = (async () => {
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await stderrReader.read()
      if (done) break
      stderr += decoder.decode(value, { stream: true })
    }
  })()

  try {
    const decoder = new TextDecoder()
    let output = ''
    let endpoint: string | undefined
    while (!endpoint) {
      const { done, value } = await stdoutReader.read()
      if (done) throw new Error(`MCP test server exited before starting: ${stderr}`)
      output += decoder.decode(value, { stream: true })
      endpoint = /connect at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(output)?.[1]
    }

    const post = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await fetch(endpoint!, {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`MCP request failed (${response.status}): ${text}`)
      return parseJsonRpcResponse(text)
    }

    const initialized = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'crafty-schema-test', version: '1.0.0' },
      },
    })
    expect(initialized.result).toBeDefined()

    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const result = listed.result as { tools: Array<{ title?: string; inputSchema: { properties: Record<string, unknown> } }> }
    const tool = result.tools.find((candidate) => candidate.title === 'crafty prototype <__proto__>')
    expect(tool).toBeDefined()
    const params = tool!.inputSchema.properties.params as {
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(Object.hasOwn(params.properties, '__proto__')).toBe(true)
    expect(params.properties['__proto__']?.type).toBe('string')
    expect(params.required).toContain('__proto__')
  } finally {
    clearTimeout(startupDeadline)
    child.kill('SIGTERM')
    await child.exited
    await drainStderr
    stdoutReader.releaseLock()
    stderrReader.releaseLock()
  }
})
