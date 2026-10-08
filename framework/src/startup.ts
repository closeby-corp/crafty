import { PROGRAM, run } from './cli.ts'
import { loadCommands } from './loader.ts'
import { reportFailure } from './output.ts'

export interface StartOptions {
  commandsDir: string | URL
  argv?: string[]
  program?: string
}

/** Load the client's command directory and return its invocation's exit code. */
export async function start({ commandsDir, argv = process.argv.slice(2), program = PROGRAM }: StartOptions): Promise<number> {
  try {
    await loadCommands(commandsDir)
    return await run(argv, program)
  } catch (error) {
    return reportFailure(error, { source: 'commands', path: program, usage: [] }, null, argv, program)
  }
}
