import { spyOn } from 'bun:test'
import { prepareCommand, runCommand, setOutputSink, type CommandModule } from '../../src/index.ts'

export interface CliCapture {
  code: number
  stdout: string
  stderr: string
}

/** Capture a framework invocation without spawning a second process. */
export async function captureCli(invoke: () => Promise<number>): Promise<CliCapture> {
  let stdout = ''
  const stderr: string[] = []
  const outer = setOutputSink((text) => {
    stdout += text
  })
  const spy = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
  try {
    const code = await invoke()
    return { code, stdout, stderr: stderr.join('') }
  } finally {
    setOutputSink(outer)
    spy.mockRestore()
  }
}

/** Runs one command through the dispatcher's parser and lifecycle executor. */
export function runCaptured(command: CommandModule, argv: string[], program?: string): Promise<CliCapture> {
  return captureCli(() => runCommand(prepareCommand(command.name!, command), argv, program))
}

/** The `--json` envelope a command printed, parsed. */
export function envelope(capture: CliCapture): Record<string, unknown> {
  return JSON.parse(capture.stdout) as Record<string, unknown>
}
