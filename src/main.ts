#!/usr/bin/env bun
import { PROGRAM, run } from './cli.ts'
import { loadCommands } from './loader.ts'
import { reportFailure } from './output.ts'

const argv = process.argv.slice(2)
try {
  await loadCommands()
  process.exitCode = await run(argv)
} catch (error) {
  process.exitCode = reportFailure(error, { source: 'commands', path: PROGRAM, usage: [] }, null, argv)
}
