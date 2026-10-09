import { spyOn } from 'bun:test'
import { run, setOutputSink } from 'crafty'

export interface CliCapture {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run one invocation of the installed registry the way the executable does,
 * with framework stdout captured in-process and stderr spied.
 */
export async function capture(argv: string[]): Promise<CliCapture> {
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
    return { code: await run(argv), stdout, stderr: stderr.join('') }
  } finally {
    setOutputSink(outer)
    spy.mockRestore()
  }
}

/** The `--json` envelope an invocation printed, parsed. */
export function envelope(result: CliCapture): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>
}
