# Crafty framework

Bun routing, argument parsing, help, lifecycle hooks, invocation context, and structured output/errors for client-owned TypeScript commands. Requires Bun >= 1.4.

The `crafty` package contains the framework and its [authoring skill](SKILL.md). It ships no client commands, configuration template, or executable. The repository's optional example client is not a package dependency.

## Install

Crafty is not published to npm. Install the versioned GitHub release asset in your client repository:

```bash
bun add https://github.com/closeby-corp/crafty/releases/download/v0.8.0/crafty-0.8.0.tgz
```

Commit the dependency manifest, `bun.lock`, command files, and client entrypoint. The manifest and lockfile select the installed framework version; Git versions the client commands.

For agent-assisted command authoring and CLI workflow guidance, read `node_modules/crafty/SKILL.md`. The skill ships in the package and is exposed as `crafty/SKILL.md`; packaging does not automatically register it with an agent.

## Optional client skills plugin

Clients can expose their own static workflow skills with `crafty/plugins/skills`. The framework provides a plugin factory; it neither supplies client workflow skills nor installs them automatically. Keep each skill in a flat `skills/<name>/SKILL.md` directory, with matching frontmatter `name` and a non-empty `description`.

```ts
// commands/skills.ts
import { createSkillsPlugin } from 'crafty/plugins/skills'

export default createSkillsPlugin({
  skillsDir: new URL('../skills/', import.meta.url),
})
```

The generated `skills list` and `skills show <name>` routes read and validate the local catalog. They do not invoke the installer or contact a network. The explicit `skills install` route delegates installation to the pinned Skills CLI (`bun x --bun skills@1.7.1 add <source>`); the first real install may download that pinned package. It accepts repeatable `--skill` and `--agent` selections, `--global`, `--copy`, `--yes`, and `--dry-run`. Project destinations use the install command's current working directory. Global scope is selected only with `--global`. Actual JSON or non-interactive installs require `--yes` and explicit skill and agent selections; an interactive human terminal may make those selections in the installer. Interactive mode preserves upstream output and exit status, which may not reveal a partial failure; use explicit selections with `--yes` for verified install records. Non-interactive installs request and validate upstream JSON results before reporting success. Dry-run returns the delegated request without launching it.

The catalog uses only flat `skills/<name>/SKILL.md` entries; a root `SKILL.md` is unsupported. A boolean `internal: true` frontmatter field hides a skill from listing, showing, and installation. Symbolic links in skill directories, documents, and resources are rejected.

The configured source directory is resolved from the client command module, not the current working directory. Skills belong to the client that owns the executable and should be included only in a distribution of that client. Keep them out of the framework package allowlist: they describe that client's workflows and commands. Skill content guides an agent; it does not extend Crafty's execution runtime or authorize writes.

## Optional client update plugin

Clients can add `crafty/plugins/update` to update the Git repository that owns their CLI. Set `repositoryDir` explicitly from the client command module so the target does not depend on the shell's current directory:

```ts
// commands/update.ts
import { createUpdatePlugin } from 'crafty/plugins/update'

export default createUpdatePlugin({
  repositoryDir: new URL('../../', import.meta.url),
})
```

`crafty update` refuses to run with tracked or untracked changes and uses Git's fast-forward-only pull for the current branch's configured upstream. It does not stash, create merge commits, reset, install dependencies, or restart the process. If the repository's dependency manifest or lockfile changed, install dependencies yourself; restart the CLI to load updated command code. `crafty update --check` checks immediately without changing the working tree.

When enabled, an interactive invocation checks for updates at most once per day by default and writes a notice to stderr. Set `autoCheck: false` or change `checkIntervalMs` to customize that behavior. The check has a three-second total time budget; failures and timeouts do not fail the command being run. `update --check` gets a longer, 15-second budget. For a `github.com` remote, the plugin tries `gh api` first, using the installed GitHub CLI's existing authentication; if that fails or cannot compare the local commit, it falls back to Git fetch. Other Git remotes use Git fetch. GitHub Enterprise hosts are not detected automatically yet. The notification cache is stored in the user's cache directory.

The update route is marked `mcp: 'write'`, so the MCP server keeps it blocked unless the server operator explicitly enables writes. Ordinary MCP arguments cannot authorize the repository update.

## Optional HTTP MCP plugin

Clients can expose their configured leaf commands over MCP Streamable HTTP with `crafty/plugins/mcp`. Register it as a client-owned command module:

```ts
// commands/mcp.ts
import { createMcpPlugin } from 'crafty/plugins/mcp'

export default createMcpPlugin()
```

Then run `crafty mcp serve`. The server binds to `127.0.0.1:8787` by default and serves `/mcp`. Only literal loopback IP addresses receive local-bind treatment; hostnames require the remote auth, TLS, and Host allowlist settings even if they resolve to loopback. It builds its tool list from the same loaded command registry, calls the existing handlers and hooks, and inherits the `--config` path selected when the server starts. The plugin uses the official [`@modelcontextprotocol/server`](https://ts.sdk.modelcontextprotocol.io/v2/) TypeScript SDK and Bun's fetch-native HTTP server.

HTTP requests pass through the SDK's Host and Origin checks. Browser origins are limited to localhost unless added with repeatable `--allowed-origin https://console.example.com`; configured schemes must match, while ports are unrestricted. A non-loopback bind also requires `--allowed-host`, `CRAFTY_MCP_TOKEN`, and a TLS certificate and key. Generate a token with at least 32 URL-safe characters and supply certificate paths with `--tls-cert` and `--tls-key`; remote connections use HTTPS and `Authorization: Bearer <token>`. For example:

```bash
CRAFTY_MCP_TOKEN="$(openssl rand -hex 32)" crafty mcp serve \
  --host 0.0.0.0 --port 8787 \
  --allowed-host mcp.example.com \
  --allowed-origin https://console.example.com \
  --tls-cert ./server.crt --tls-key ./server.key
```

Unclassified routes and write routes are blocked by default. Mark a known read-only route `mcp: 'read'` to allow it and publish truthful read-only tool annotations. Mark a route `mcp: 'write'` to require server-side write authorization; routes with a declared `--yes` option are treated the same way. Read/write policies inherit through descendants, so mark a parent read-only only when all of its leaves are read-only. Set `CRAFTY_MCP_ALLOW_WRITES=1` in the server environment to authorize write and unclassified routes. The MCP schema never accepts `yes`; the adapter supplies it only after that server-level opt-in. Unclassified routes have no read/write annotation. Mark a route `mcp: 'hidden'` to omit it and its descendants. Client command authors must label every route that changes remote or host state, because arbitrary handler side effects cannot be inferred from TypeScript code.

Each tool takes dynamic route values under `params`, free positionals under `args`, tokens after `--` under `tail`, and non-sensitive declared flags under `options`. Repeated string flags use arrays. Crafty does not declare positional names, positional sensitivity, or required-option metadata, so `args` is intentionally generic and handler validation remains authoritative; commands should not accept secrets as positionals. MCP calls always request Crafty's JSON envelope. Sensitive options, output controls, `--config`, and confirmation flags are not tool inputs; configure credentials and server configuration in the client environment or the server's selected config instead.

The adapter captures Crafty stdout, diagnostics, selected configuration, and secret registrations per invocation, so concurrent tool calls do not share those values. It bounds each tool input to 4 MiB and 256 argument values, returned stdout to 1 MiB, and diagnostics to 128 KiB. Direct `process.stdout`/`process.stderr` or `console` writes and mutable module-level state remain the client's responsibility; MCP handlers run in the same process with the server's operating-system permissions.

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

A node has either `run` or nonempty `commands`. Function children are leaf-handler shorthand. Static routes and aliases take precedence over a single `:parameter` child per group. Options belong to a route node and are inherited along the selected path. Declarations on sibling routes are allowed, but using a sibling-only flag is rejected regardless of where it appears. Options may appear before or after route tokens. Tokens following `--` remain untouched in `ctx.tail`.

Declare only `boolean` or `string` options. String options can set `repeatable: true` or `sensitive: true`; the legacy node-level `repeatable: ['name']` declaration remains supported.

```ts
options: [
  { name: 'tag', type: 'string', repeatable: true },
  { name: 'api-key', type: 'string', sensitive: true },
]
```

Read parsed values from `ctx.values`, repeated values from `ctx.repeat`, captured route values from `ctx.params`, remaining positionals from `ctx.positionals`, and the untouched suffix after standalone `--` from `ctx.tail`. `completion` suggests values but does not validate them or provide defaults.

`init(ctx)` runs outermost to innermost; `destroy(ctx)` runs in reverse order, including teardown of a node whose initialization failed. Selected hooks and the handler share one context with fresh `params` and `state`. Help and invalid routes do not run hooks.

Handlers return nothing for exit 0, or an integer in 0–255. Return values are not serialized; use output helpers. JSON output commits only after successful teardown. A primary failure or explicit nonzero status takes precedence over cleanup failures.

## Mutation previews and result data

Use `gateMutation(ctx, description, planned)` to require `--yes` for a write and show a redacted request preview with `--dry-run`. Previews mask common credential field/long-option names and values from options declared `sensitive: true`. `registerSecret(value)` masks every nonempty explicit value, including values shorter than eight characters. For a custom subprocess, pass the selected route's sensitive spellings through as preview-only metadata:

```ts
if (gateMutation(ctx, 'set key', {
  argv: ['cloud', 'set-key', '--api-key', key],
  sensitiveArgvOptions: ctx.sensitiveArgvOptions,
}) === 'stop') return
await cloud.setKey(key)
emitResult(ctx, { updated: true })
```

The context list contains sensitive option spellings declared on the selected route. It masks values in this preview argv only, not unrelated subprocess arguments, logs, hints, or normal result data. Keep credentials out of those outputs.

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

Open a new interactive shell after installation. Bash registration is appended to `$HOME/.bashrc`; Zsh uses `$ZDOTDIR/.zshrc`, or `$HOME/.zshrc` when `ZDOTDIR` is unset. Bash automatically reads `.bashrc` in interactive non-login shells. Interactive login shells read a login profile instead, so if that profile does not already source `.bashrc`, add the shell-quoted `source ~/.bashrc` equivalent reported by the installer. The same activation notice is included as `activation` in the JSON result. The marked block checks that the executable is on `PATH`, then loads its adapter. Zsh runs `compinit` only when `compdef` is not already available.

Each executable has a separate block, so distinct client names coexist. Repeat installs leave the file unchanged. Existing startup bytes, permissions, and symlinks are preserved; new startup files use mode `0600`. Installation rejects edited/incomplete managed blocks; remove that block before reinstalling. To uninstall registration, remove its marked block. `--json` reports `shell`, `path`, `changed`, and the human-readable `activation` notice in the normal result envelope.

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

- `start({ commandsDir, argv?, program? }): Promise<number>` discovers commands, runs top-level `onStart` hooks in command-file order, then dispatches the invocation. `commandsDir` accepts a filesystem path or file URL; `argv` defaults to process arguments and `program` to `crafty`. The caller sets `process.exitCode`.
- `CommandModule`, `CommandNode`, `CommandHandler`, `CommandHook`, `CommandStartupHook`, `CommandStartupContext`, `Ctx`, and `OptionSpec` describe commands and their invocation context. Startup hooks receive argv, program, command-directory, and terminal context.
- `CompletionContext`, `CompletionProvider`, and `ValueCompletion` describe client-owned lazy value completion.
- `createSkillsPlugin({ skillsDir })` builds client-owned list, show, and explicit install routes from a local skill source.
- `createUpdatePlugin({ repositoryDir, checkIntervalMs?, autoCheck?, cacheDirectory? })` adds a safe Git updater and optional interactive notices; updater work is anchored to the configured repository.
- `createMcpPlugin()` builds the opt-in `mcp serve` command from the active client command registry.
- `emitResult`, envelope/table helpers, `flag`, `option`, argument-value helpers, `write`, and `writeErr` provide the existing output contract.
- `OpsError`, `ConfigError`, `usageError`, error classification, and secret-redaction helpers provide shared diagnostics.
- `loadCommands`, `run`, `prepareCommand`, `runCommand`, registry helpers, `configPathFromCli`, and `setOutputSink` support generic in-process composition.

Import from `crafty`, not private source paths. `program` changes generated help, routing context, and diagnostics; explicitly authored command usage remains verbatim. The command registry and fallback output sink remain process-global. The MCP plugin isolates its own output, config, and secret scopes per call, but it does not sandbox handlers or isolate client-owned mutable module state.

The framework recognizes `--config`; the client decides how that path is interpreted. Each top-level `run()` or `runCommand()` call starts with a fresh selected config path; nested calls inherit it, and a child's `--config` override is restored to the parent after success or failure. HTTP clients, credential resolution, SQL engines, SSH, and service-specific configuration schemas remain client-owned.

## Development and packaging

From the repository root, `bun install --frozen-lockfile` installs the framework and client workspaces. The client uses `crafty: workspace:*`; external clients use the released package instead.

```bash
# From framework/
bun run test
bun run typecheck
bun pm pack
```

`bun run test` includes a packed-consumer test: it creates a tarball, installs it in a temporary client, and exercises its public imports, command discovery, JSON output, errors, logging, and packaged skill from another working directory. CI runs install, tests, and typecheck on Ubuntu, macOS, and Windows with Bun 1.4.2. Bash completion integration is POSIX-only and runs with Bash 4+; core and packed-consumer tests also run on Windows.

The package allowlist includes framework `src/` and `SKILL.md`; the standard manifest and README are also included. It excludes the client workspace and all client-owned skills and integrations. No compiled binary or adjacent-source-tree layout is required.

## 0.8.0 changes

- Added the optional client updater with clean-worktree checks, fast-forward-only pulls, automatic notices, and GitHub CLI comparison support.
- Added top-level command startup hooks for opt-in plugins.

## 0.7.0 changes

- Added the optional `crafty/plugins/mcp` server for Streamable HTTP and asynchronous request-local output, config, and secret scopes.
- Added inherited MCP route policies and guarded write execution, plus browser CORS support for the modern `Mcp-Name` header.
- Added regression coverage for dynamic parameters shadowing static routes and prototype-spelled route parameters.

## 0.6.0 changes

Added the optional `crafty/plugins/skills` factory for validating, listing, showing, and installing client-owned workflow skills. Installs delegate to the pinned Skills CLI, with JSON-verified results for non-interactive installations. Added string option repeatability/sensitivity, selected-route validation, config invocation scoping, safer preview and diagnostic redaction, and cross-platform package-consumer CI. Verified with the complete framework and client suites, both typechecks, a temporary-project install, and skill validation.

## 0.5.1 changes

Removed flag-name suggestions from completion menus. Commands, aliases, configured route identifiers, and values for explicitly typed options remain supported. Verified with the framework and example-client suites, both typechecks, direct CLI queries, and actual Bash Tab interactions showing no flags.

## 0.5.0 changes

Added lazy synchronous/asynchronous value providers for inherited string options and dynamic route parameters, including selected configuration paths and captured parameters. Verified with 50 framework tests, 8 example-client tests, both typechecks, direct CLI queries, and interactive Bash Tab completion against an isolated configuration.

At the time of Crafty 0.5.0, the packaged skill covered command and recipe authoring. It ships as `SKILL.md` with installed-package links and guidance for configuration-backed completion.

## 0.4.0 changes

Added `completion install` to the optional plugin. Registration is explicit, per-executable, idempotent, and honors Zsh's `ZDOTDIR`. Existing startup files are appended to rather than replaced, including symlinked dotfiles. Verified with 45 framework tests, both workspace typechecks, and actual new-shell Bash/Zsh Tab interactions in isolated clients.

## 0.3.0 changes

Added the optional completion plugin and explicit enum/file/directory option metadata. Dynamic shell registration is verified with actual Tab interactions in Bash 5.2 and Zsh 5.9, including live command changes and literal insertion of shell metacharacters. The Bash adapter requires version 4 or newer.

## 0.2.0 changes

The framework is now an independently installable package with explicit client startup and discovery. All 13 existing command modules and their assets moved to the optional sibling client workspace. The previous bundled entrypoint and compiled launcher were removed.
