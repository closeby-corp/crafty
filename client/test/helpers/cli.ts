import { spyOn } from 'bun:test'
import { setOutputSink, prepareCommand, runCommand, type CommandModule } from 'crafty'

export interface CliCapture {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs one command the way the dispatcher does, with stdout captured in-process
 * (the recipe engine's own mechanism) and stderr spied, so a test can assert on
 * exactly what an operator would see.
 */
export async function runCaptured(command: CommandModule, argv: string[]): Promise<CliCapture> {
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
    const code = await runCommand(prepareCommand(command.name!, command), argv)
    return { code, stdout, stderr: stderr.join('') }
  } finally {
    setOutputSink(outer)
    spy.mockRestore()
  }
}

/** The `--json` envelope a command printed, parsed. */
export function envelope(capture: CliCapture): Record<string, unknown> {
  return JSON.parse(capture.stdout) as Record<string, unknown>
}
