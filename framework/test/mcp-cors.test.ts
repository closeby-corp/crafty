import { expect, spyOn, test } from 'bun:test'
import { createMcpPlugin } from '../src/plugins/mcp.ts'
import { runCaptured } from './helpers/cli.ts'

test('MCP CORS preflight allows the modern-protocol Mcp-Name header', async () => {
  const previousToken = process.env.CRAFTY_MCP_TOKEN
  delete process.env.CRAFTY_MCP_TOKEN
  let fetchHandler: ((request: Request) => Response | Promise<Response>) | undefined
  let signalHandler: (() => void) | undefined
  let markServerReady!: () => void
  const serverReady = new Promise<void>((resolve) => { markServerReady = resolve })
  const originalOnce = process.once.bind(process)
  const onceSpy = spyOn(process, 'once').mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGINT' || event === 'SIGTERM') signalHandler = listener as () => void
    else originalOnce(event as never, listener as never)
    return process
  }) as never)
  const serveSpy = spyOn(Bun, 'serve').mockImplementation(((options: { fetch: (request: Request) => Response | Promise<Response> }) => {
    fetchHandler = options.fetch
    markServerReady()
    return { port: 12345, stop: () => true } as never
  }) as never)
  let invocation: Promise<unknown> | undefined

  try {
    invocation = runCaptured(createMcpPlugin(), ['serve', '--port', '0'], 'crafty')
    const started = await Promise.race([
      serverReady.then(() => true),
      invocation.then(() => false, () => false),
    ])
    expect(started).toBe(true)

    const response = await fetchHandler!(new Request('http://127.0.0.1:12345/mcp', {
      method: 'OPTIONS',
      headers: {
        Host: '127.0.0.1:12345',
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'mcp-name',
      },
    }))
    const allowedHeaders = response.headers.get('Access-Control-Allow-Headers')?.toLowerCase().split(',').map((header) => header.trim())

    expect(response.status).toBe(204)
    expect(allowedHeaders).toContain('mcp-name')
  } finally {
    signalHandler?.()
    try {
      await invocation
    } finally {
      serveSpy.mockRestore()
      onceSpy.mockRestore()
      if (previousToken === undefined) delete process.env.CRAFTY_MCP_TOKEN
      else process.env.CRAFTY_MCP_TOKEN = previousToken
    }
  }
})
