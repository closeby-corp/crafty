# Crafty framework

Bun routing, argument parsing, help, lifecycle hooks, invocation context, and structured output/errors for client-owned TypeScript commands. Requires Bun >= 1.4.

The `crafty` package contains the framework and its [authoring skill](SKILL.md). It ships no integration commands, recipes, configuration template, or executable. The repository's optional client workspace is not a package dependency.

## Install

Crafty is not published to npm. Install the versioned GitHub release asset in your client repository:

```bash
bun add https://github.com/closeby-corp/crafty/releases/download/v0.5.1/crafty-0.5.1.tgz
```

Commit the dependency manifest, `bun.lock`, command files, and client entrypoint. The manifest and lockfile select the installed framework version; Git versions the client commands.

For agent-assisted command and recipe authoring, read `node_modules/crafty/SKILL.md`. The skill ships in the package and is exposed as `crafty/SKILL.md`; packaging does not automatically register it with an agent.

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

## Optional completion plugin

Create `commands/completion.ts` in the client:

```ts
export { default } from 'crafty/plugins/completion'
```

The module is shipped with the framework but not automatically registered. Remove the client module to disable the command.

Use your client's executable name instead of `crafty` when it has a different `bin` name and matching `start({ program })`.

With Crafty 0.4.0 or newer, install dynamic registration with:

```bash
crafty completion install               # detect the login shell from $SHELL
crafty completion install --shell bash  # Bash 4+
crafty completion install --shell zsh
```

Open a new shell after installation. Bash registration is appended to `$HOME/.bashrc`; Zsh uses `$ZDOTDIR/.zshrc`, or `$HOME/.zshrc` when `ZDOTDIR` is unset. The marked block checks that the executable is on `PATH`, then loads its adapter. Zsh runs `compinit` only when `compdef` is not already available.

Each executable has a separate block, so distinct client names coexist. Repeat installs leave the file unchanged. Existing startup bytes, permissions, and symlinks are preserved; new startup files use mode `0600`. Installation rejects edited/incomplete managed blocks; remove that block before reinstalling. To uninstall registration, remove its marked block. `--json` reports `shell`, `path`, and `changed` in the normal result envelope.

For manual registration, add `source <(crafty completion bash)` to `~/.bashrc` (Bash 4+), or `source <(crafty completion zsh)` after `compinit` in `~/.zshrc`. These generation commands never write startup files; only explicit `completion install` does.

The shell adapter queries the executable on every Tab request. Command/alias changes are visible without re-sourcing or relinking. The query resolves nested static routes and consumed dynamic parameters, and handles separate/attached option values. Flag names are never suggested, even after typing a dash prefix; type an option explicitly to complete its declared values. `help` routing is supported; completion stops at a standalone `--`.

Declare option values explicitly:

```ts
options: [
  { name: 'mode', type: 'string', completion: ['fast', 'safe'] },
  { name: 'input', type: 'string', completion: 'file' },
  { name: 'directory', type: 'string', completion: 'directory' },
]
```

File/directory discovery uses the shell's native completer. String options without completion metadata have no inferred values. The global `--config` option completes files, and `--format` completes its supported values.

In Crafty 0.5.0 and newer, use a synchronous or asynchronous `CompletionProvider` for configuration-backed values. Adapt your existing client loader to accept the provider's `configPath` override; the framework does not parse configuration or prescribe its schema:

```ts
const configuredHosts: CompletionProvider = async ({ configPath }) => {
  const config = await loadConfig(configPath)
  return Object.keys(config.hosts)
}

// An option declared on a parent is inherited by its descendants:
options: [{ name: 'host', type: 'string', short: 'H', completion: configuredHosts }]

// A dynamic child's completion supplies values for that :parameter:
commands: {
  ':host': { completion: configuredHosts, run: inspectHost },
}
```

`CompletionContext` contains `configPath` (the last complete `--config`, `--config=`, or `-c` before the cursor), previously captured `params`, the value `prefix`, cursor `index`, and `words` through the cursor, including the executable. Without an explicit config path, the client loader chooses its normal defaults. Pass `configPath` to the loader explicitly: `configPathFromCli()` does not see the target words transported after the query's `--`.

Providers run only for the value being completed, and are awaited on every query. Arrays and provider results are prefix-filtered, deduplicated, and sorted. Separate values, `--host=value`, short attached values, and repeatable options are supported. Route-local option declarations override ancestors. Dynamic values coexist with static commands/aliases; static routes still win when resolving an entered word. No infrastructure API is contacted automatically.

Target handlers and `init`/`destroy` hooks are not called by completion lookup. Modules are still imported on each query, so keep import-time code free of side effects and load configuration inside providers. Provider errors fail the query normally; shell adapters suppress diagnostics and offer no candidates. Return only public identifiers, never credentials; providers must not write to stdout. Suggestions are transported as literal NUL-delimited records, not evaluated as shell code. File paths and configured values retain quoting when inserted.

The `completion query --index <n> -- <words...>` route is the shell adapter's machine-readable endpoint. Words include the executable at index zero; words after the cursor are ignored.

## Public API

- `start({ commandsDir, argv?, program? }): Promise<number>` discovers commands and runs the invocation. `commandsDir` accepts a filesystem path or file URL; `argv` defaults to process arguments and `program` to `crafty`. The caller sets `process.exitCode`.
- `CommandModule`, `CommandNode`, `CommandHandler`, `CommandHook`, `Ctx`, and `OptionSpec` describe commands and their invocation context.
- `CompletionContext`, `CompletionProvider`, and `ValueCompletion` describe client-owned lazy value completion.
- `emitResult`, envelope/table helpers, `flag`, `option`, argument-value helpers, `write`, and `writeErr` provide the existing output contract.
- `OpsError`, `ConfigError`, `usageError`, error classification, and secret-redaction helpers provide shared diagnostics.
- `loadCommands`, `run`, `prepareCommand`, `runCommand`, registry helpers, `configPathFromCli`, and `setOutputSink` support client-owned composition, including recipes.

Import from `crafty`, not private source paths. `program` changes generated help, routing context, and diagnostics; explicitly authored command usage remains verbatim. The registry and output sink are process-global: use one client at a time within a process, not concurrent independent hosts.

The framework recognizes `--config`; the client decides how that path is interpreted. HTTP clients, credential resolution, SQL engines, SSH, recipes, and service-specific configuration schemas remain client-owned.

## Development and packaging

From the repository root, `bun install --frozen-lockfile` installs the framework and client workspaces. The client uses `crafty: workspace:*`; external clients use the released package instead.

```bash
# From framework/
bun run test
bun run typecheck
bun pm pack
```

The package allowlist includes `src/` and `SKILL.md`; the standard manifest and README are also included. It excludes the client workspace and every integration. No compiled binary or adjacent-source-tree layout is required.

## 0.5.1 changes

Removed flag-name suggestions from completion menus. Commands, aliases, configured route identifiers, and values for explicitly typed options remain supported. Verified with the framework and example-client suites, both typechecks, direct CLI queries, and actual Bash Tab interactions showing no flags.

## 0.5.0 changes

Added lazy synchronous/asynchronous value providers for inherited string options and dynamic route parameters, including selected configuration paths and captured parameters. Verified with 50 framework tests, 8 example-client tests, both typechecks, direct CLI queries, and interactive Bash Tab completion against an isolated configuration.

The client command/recipe authoring skill now ships as `SKILL.md` in the package, with installed-package links and guidance for configuration-backed completion.

## 0.4.0 changes

Added `completion install` to the optional plugin. Registration is explicit, per-executable, idempotent, and honors Zsh's `ZDOTDIR`. Existing startup files are appended to rather than replaced, including symlinked dotfiles. Verified with 45 framework tests, both workspace typechecks, and actual new-shell Bash/Zsh Tab interactions in isolated clients.

## 0.3.0 changes

Added the optional completion plugin and explicit enum/file/directory option metadata. Dynamic shell registration is verified with actual Tab interactions in Bash 5.2 and Zsh 5.9, including live command changes and literal insertion of shell metacharacters. The Bash adapter requires version 4 or newer.

## 0.2.0 changes

The framework is now an independently installable package with explicit client startup and discovery. All 13 existing command modules and their assets moved to the optional sibling client workspace. The previous bundled entrypoint and compiled launcher were removed.
