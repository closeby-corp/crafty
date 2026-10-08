import { afterEach } from 'bun:test'

export interface RecordedRequest {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
}

export interface MockReply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export interface MockRoute extends MockReply {
  /** Exact path, or a prefix match when it ends with `*`. */
  path: string
  /** Answers this route instead of the static reply; receives how many requests already hit it. */
  handler?: (request: RecordedRequest, seen: number) => MockReply
}

export interface MockServer {
  url: string
  requests: RecordedRequest[]
  /** Requests that arrived, filtered by method. */
  of(method: string): RecordedRequest[]
}

const running: Array<() => void> = []

afterEach(() => {
  while (running.length > 0) running.pop()!()
})

/** A server on port 0 that answers from `routes` and remembers every request. */
export function startMockServer(routes: MockRoute[]): MockServer {
  const requests: RecordedRequest[] = []
  const hits = new Map<string, number>()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const recorded: RecordedRequest = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text(),
      }
      requests.push(recorded)

      const route = routes.find(
        (candidate) =>
          candidate.path === url.pathname ||
          (candidate.path.endsWith('*') && url.pathname.startsWith(candidate.path.slice(0, -1))),
      )
      if (route === undefined) {
        return new Response(JSON.stringify({ message: `no route for ${request.method} ${url.pathname}` }), { status: 404 })
      }

      const seen = hits.get(route.path) ?? 0
      hits.set(route.path, seen + 1)
      const reply = route.handler === undefined ? route : route.handler(recorded, seen)
      const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
      return new Response(body, {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers },
      })
    },
  })

  running.push(() => void server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    of: (method) => requests.filter((request) => request.method === method),
  }
}
