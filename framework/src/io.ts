import { AsyncLocalStorage } from 'node:async_hooks'

export type TextSink = (text: string) => void

interface OutputSinks {
  stdout?: TextSink | null
  stderr?: TextSink | null
}

const outputScope = new AsyncLocalStorage<OutputSinks>()
let defaultOutputSink: TextSink | null = null

/** The process-level fallback sink, retained for existing CLI integrations. */
export function setDefaultOutputSink(sink: TextSink | null): TextSink | null {
  const previous = defaultOutputSink
  defaultOutputSink = sink
  return previous
}

/** Override framework stdout for the current async invocation, if present. */
export function setOutputSink(sink: TextSink | null): TextSink | null {
  const local = outputScope.getStore()
  if (!local) return setDefaultOutputSink(sink)
  const previous = local.stdout === undefined ? defaultOutputSink : local.stdout
  local.stdout = sink
  return previous
}

/** Route framework output within one asynchronous invocation. */
export function withOutputSinks<T>(sinks: OutputSinks, callback: () => Promise<T>): Promise<T> {
  return outputScope.run({ ...outputScope.getStore(), ...sinks }, callback)
}

function onClosedPipe(error: unknown): boolean {
  return (error as { code?: string }).code === 'EPIPE'
}

export function writeOutput(text: string): void {
  const local = outputScope.getStore()?.stdout
  const sink = local === undefined ? defaultOutputSink : local
  if (sink) {
    sink(text)
    return
  }
  try {
    process.stdout.write(text)
  } catch (error) {
    if (!onClosedPipe(error)) throw error
  }
}

export function writeError(text: string): void {
  const local = outputScope.getStore()?.stderr
  if (local) {
    local(text)
    return
  }
  try {
    process.stderr.write(text)
  } catch (error) {
    if (!onClosedPipe(error)) throw error
  }
}
