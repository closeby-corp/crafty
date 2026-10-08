#!/usr/bin/env bun
import { start } from 'crafty'

process.exitCode = await start({ commandsDir: new URL('./commands/', import.meta.url) })
