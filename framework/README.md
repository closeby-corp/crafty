# Crafty framework

Bun routing, argument parsing, help, lifecycle hooks, invocation context, and structured output/errors for client-owned TypeScript commands. Requires Bun >= 1.4.

The `crafty` package contains the framework only. It ships no integration commands, recipes, configuration template, or executable. The optional existing infrastructure application is a sibling workspace in [`../client/`](../client/README.md), not a package dependency.

## Install

Crafty is not published to npm. Install the versioned GitHub release asset in your client repository:

```bash
bun add https://github.com/closeby-corp/crafty/releases/download/v0.2.0/crafty-0.2.0.tgz
```

Commit the dependency manifest, `bun.lock`, command files, and client entrypoint. The manifest and lockfile select the installed framework version; Git versions the client commands.

## Link a client executable

Create `cli.ts`:

```ts
#!/usr/bin/env bun
import { start } from 'crafty'

process.exitCode = await start({
  commandsDir: new URL('./commands/', import.meta.url),
  program: 'crafty',
})
```

Add a `bin` entry to the client's `package.json`:

```json
{
  "bin": { "crafty": "./cli.ts" }
}
```

Create `commands/`, make the entrypoint executable (`chmod +x cli.ts`), and run `bun link` from the client repository. With Bun's global bin directory on `PATH`, the executable works from anywhere. It imports the Crafty version installed in this client's `node_modules`, not a global framework installation.

Command discovery is anchored to the entrypoint's location. An empty command directory is valid. Adding, editing, or removing a command takes effect on the next invocation without rebuilding or relinking. Only designated command modules become commands, not arbitrary files elsewhere in the repository.

Use distinct executable names for multiple clients: linking another `crafty` executable can replace an existing link. `bun unlink` unregisters the client package.

## Commands

Create `commands/hello.ts`:

```ts
import { emitResult, type CommandModule } from 'crafty'

export default {
  summary: 'Greet a subject',
  commands: {
    ':subject': {
      run(ctx) {
        emitResult(ctx, { greeting: `Hello, ${ctx.params.subject}` })
      },
    },
  },
} satisfies CommandModule
```

Run `crafty hello world --json`. The module basename supplies the root name unless `name` overrides it.

Discovery imports direct regular `.ts` files in filename order. Declaration files, subdirectories, and symlinks are ignored. Keep helpers and tests outside the command directory. Invalid modules and colliding root names/aliases fail startup with an actionable diagnostic; they are not silently skipped. Modules execute with the operator's permissions and are not sandboxed.

A node has either `run` or nonempty `commands`. Function children are leaf-handler shorthand. Static routes and aliases take precedence over a single `:parameter` child per group. Tokens following `--` remain untouched in `ctx.tail`.

`init(ctx)` runs outermost to innermost; `destroy(ctx)` runs in reverse order, including teardown of a node whose initialization failed. Selected hooks and the handler share one context with fresh `params` and `state`. Help and invalid routes do not run hooks.

Handlers return nothing for exit 0, or an integer in 0–255. Return values are not serialized; use output helpers. JSON output commits only after successful teardown. A primary failure or explicit nonzero status takes precedence over cleanup failures.

## Public API

- `start({ commandsDir, argv?, program? }): Promise<number>` discovers commands and runs the invocation. `commandsDir` accepts a filesystem path or file URL; `argv` defaults to process arguments and `program` to `crafty`. The caller sets `process.exitCode`.
- `CommandModule`, `CommandNode`, `CommandHandler`, `CommandHook`, `Ctx`, and `OptionSpec` describe commands and their invocation context.
- `emitResult`, envelope/table helpers, `flag`, `option`, argument-value helpers, `write`, and `writeErr` provide the existing output contract.
- `OpsError`, `ConfigError`, `usageError`, error classification, and secret-redaction helpers provide shared diagnostics.
- `loadCommands`, `run`, `prepareCommand`, `runCommand`, registry helpers, `configPathFromCli`, and `setOutputSink` support client-owned composition, including recipes.

Import from `crafty`, not private source paths. `program` changes generated help, routing context, and diagnostics; explicitly authored command usage remains verbatim. The registry and output sink are process-global: use one client at a time within a process, not concurrent independent hosts.

The framework recognizes `--config`; the client decides how that path is interpreted. HTTP clients, credential resolution, SQL engines, SSH, recipes, and service-specific configuration schemas remain client-owned.

## Development and packaging

From the repository root, `bun install --frozen-lockfile` installs the framework and included client workspaces. The client uses `crafty: workspace:*`; external clients use the released package instead.

```bash
# From framework/
bun run test
bun run typecheck
bun pm pack
```

The package allowlist includes only `src/`; the standard manifest and README are also included. It excludes the client and all integrations. No compiled binary or adjacent-source-tree layout is required.

## 0.2.0 changes

The framework is now an independently installable package with explicit client startup and discovery. All 13 existing command modules and their assets moved to the optional sibling client workspace. The previous bundled entrypoint and compiled launcher were removed.
