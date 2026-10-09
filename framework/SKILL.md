---
name: crafty-authoring
description: Create or modify client-owned Crafty CLI commands and workflow skills. Use when adding command routes, arguments, lifecycle hooks, configuration access, completion metadata, a skills catalog, or guidance for a Bun client that imports crafty.
---

# Crafty command and CLI workflow authoring

Crafty is an installed Bun framework. Target the client's installed version and conventions. Inspect its dependency manifest, executable entrypoint, neighboring commands, helpers, and tests before editing. Import public APIs from `crafty` or documented subpaths, never private source paths. The packaged framework and this skill do not install or register a client CLI automatically.

## Find and edit the client

Read the entrypoint to find `start({ commandsDir, program })` and use its CLI name in examples. Put discovered command modules in the configured directory, and keep helpers and tests outside it. Reuse the client's configuration, transport, credential, and output conventions. An application-specific operation usually belongs in the client, not in the framework.

A minimal entrypoint is:

```ts
#!/usr/bin/env bun
import { start } from 'crafty'

process.exitCode = await start({
  commandsDir: new URL('./commands/', import.meta.url),
  program: 'toolbox',
})
```

## Declare command routes and options

Discovery imports direct regular `.ts` files in filename order. The filename supplies the root command name unless the module sets `name`. Default-export a plain object checked with `satisfies CommandModule`.

```ts
import { emitResult, flag, option, type CommandModule } from 'crafty'

export default {
  summary: 'Greet a subject',
  options: [
    { name: 'language', type: 'string', short: 'l', completion: ['en', 'pt'] },
    { name: 'shout', type: 'boolean' },
  ],
  commands: {
    ':subject': {
      run(ctx) {
        const language = option(ctx.values, 'language') ?? 'en'
        const greeting = `${language === 'pt' ? 'Olá' : 'Hello'}, ${ctx.params.subject}`
        emitResult(ctx, { greeting: flag(ctx.values, 'shout') ? greeting.toUpperCase() : greeting })
      },
    },
  },
} satisfies CommandModule
```

- A node has either `run` or nonempty `commands`. Static child names and aliases win over a `:parameter` child; each sibling set can have at most one parameter child. Options can be declared on sibling routes, but only options on the selected route and its ancestors are accepted.
- Options are declared as `OptionSpec` entries. String options can set `repeatable: true` or `sensitive: true`; read values with `option(ctx.values, name)` and `ctx.repeat[name]`. The legacy node-level `repeatable: ['name']` form remains supported.
- Flags inherit along the selected route. Options may appear before or after route words; option use is checked against the selected route and its ancestors. Use `--` to end option parsing; all following arguments stay in `ctx.tail` unchanged. Pass argument arrays to subprocess APIs and do not concatenate untrusted values into shell code.
- `completion` suggests values; it does not validate them or supply defaults. Validate user input and its count explicitly. Only `boolean` and `string` option types exist.
- Global options include help, config, JSON, format, color, and verbose controls. Do not reuse their names or short flags. Explicit `usage` strings remain verbatim, so update them when command behavior changes.

## Handle resources, output, and writes

`init(ctx)` runs from the root to the selected route and `destroy(ctx)` runs in reverse, including when initialization fails. Ancestors and the handler share invocation-local `ctx.state` and `ctx.params`. Acquire resources in hooks or handlers, not during module import, and make teardown safe after partial acquisition.

Use `emitResult(ctx, data, meta?)` for structured output. A returned object is not serialized; handlers return nothing or an exit status from 0 to 255. Use `usageError` for invalid arguments, `ConfigError` for configuration validation, and `OpsError` for operational failures. Let Crafty report errors; do not call `process.exit()` inside a command. JSON output is committed only after teardown succeeds.

Use `gateMutation(ctx, description, planned)` for writes: it requires `--yes`, while `--dry-run` prints a redacted preview and stops before the request. Sensitive declared option values are registered for log and preview redaction; `registerSecret(value)` registers every nonempty explicit value, including short ones. For custom subprocess arguments, pass `ctx.sensitiveArgvOptions` through to `planned.sensitiveArgvOptions`; this metadata applies only to the preview argv. Normal result data is not automatically redacted, so avoid emitting credentials there and use framework logging/error APIs for sanitized diagnostics. Keep progress and diagnostics off result stdout.

## Treat configuration and completion as client-owned

Crafty recognizes `--config` / `-c` and exposes the selected path through `configPathFromCli()`. It does not parse the file, inject `ctx.config`, or choose path precedence, environment names, format, schema, or caching. Use the client's shared typed loader and load configuration lazily so help, version, and completion remain available without it. Nested in-process CLI calls inherit the selected config path; a child override is restored after it finishes.

Optional plugins are enabled by an explicit client command module. For completion, create `commands/completion.ts`:

```ts
export { default } from 'crafty/plugins/completion'
```

Completion providers may use the client's configuration loader and receive the selected config path and captured route parameters. Keep them lazy, return public identifiers, and do not write stdout. Metadata lookup imports command modules but does not call target handlers or hooks, so avoid import-time side effects.

For a client's static workflow skill catalog, use the optional `crafty/plugins/skills` factory from `commands/skills.ts`:

```ts
import { createSkillsPlugin } from 'crafty/plugins/skills'

export default createSkillsPlugin({
  skillsDir: new URL('../skills/', import.meta.url),
})
```

Place skills at `skills/<name>/SKILL.md`, with the directory matching the YAML frontmatter `name` and a non-empty `description`. The plugin's `list` and `show` routes validate and read local skill files without a subprocess or network access. A root `SKILL.md` is unsupported; `internal: true` hides a skill from listing, showing, and installation; symbolic links anywhere inside a skill directory are rejected. The explicit `install` route delegates to `bun x --bun skills@1.7.1 add <source>`; a real install may download the pinned package on first use. It is a client workflow convenience, not a skill execution runtime. Keep the source anchored to the client module, and keep client-specific skills out of the framework package artifact. Project installs use the invocation working directory; global installs require the explicit `--global` option. For actual JSON or non-interactive installs, select skills and agents explicitly and pass `--yes`. Non-interactive installs request and validate upstream JSON results before reporting success. A skill can describe decisions and stopping conditions, but it does not authorize external writes by itself.

For an opt-in self-updater, create `commands/update.ts` with `createUpdatePlugin({ repositoryDir: new URL('../../', import.meta.url) })` from `crafty/plugins/update`. Point it at the repository that owns the client CLI, not the shell's current directory. `<cli> update` refuses tracked or untracked changes and uses fast-forward-only Git updates; it never stashes, resets, installs dependencies, or restarts. `<cli> update --check` only checks. When enabled, ordinary interactive invocations print a rate-limited update notice to stderr. GitHub.com repositories use `gh api` when available and then fall back to Git; other remotes use Git. The route is marked `mcp: 'write'` because it changes the host checkout.

## Expose client commands over MCP

For an optional HTTP MCP server over the same configured command tree, register `crafty/plugins/mcp` in `commands/mcp.ts`:

```ts
import { createMcpPlugin } from 'crafty/plugins/mcp'

export default createMcpPlugin()
```

`crafty mcp serve` uses the official TypeScript SDK's Streamable HTTP handler and defaults to `127.0.0.1:8787/mcp`. Only literal loopback IP addresses avoid remote-bind safeguards; hostnames require authentication, TLS, and Host allowlisting. It calls the same handlers, hooks, and selected client configuration as the CLI. Tool inputs contain dynamic route values in `params`, free positional values in `args`, post-`--` values in `tail`, and declared non-sensitive flags in `options`. Repeatable string flags are arrays. Positional argument names, sensitivity, and required-option metadata are not part of Crafty's command model, so leave command-specific validation in the handler and do not accept secrets as positionals.

Host and Origin headers are checked before MCP traffic is served. Add browser origins with repeated `--allowed-origin` URLs; configured schemes must match and ports are unrestricted. A non-loopback bind requires an allowlisted `--allowed-host`, a `CRAFTY_MCP_TOKEN` with at least 32 URL-safe characters, and a TLS cert/key pair. Store credentials in the server environment or client config; sensitive option values and `--config` paths are not exposed as tool inputs.

Unclassified routes and write routes are blocked by default. Mark a known read-only route `mcp: 'read'` to expose it and publish read-only annotations; unclassified routes have no read/write annotation. Read/write policies inherit through descendants, so mark a parent read-only only when all its leaves are read-only. Mark a route `mcp: 'hidden'` to hide it and its descendants. Mark any route that can change host or remote state as `mcp: 'write'`; routes with `--yes` are also treated as writes. Writes and unclassified routes stay blocked unless the server operator sets `CRAFTY_MCP_ALLOW_WRITES=1`. MCP arguments cannot set `yes`; the adapter adds that flag only under this server-level opt-in. This metadata is a client-author responsibility: arbitrary handler side effects cannot be inferred. The plugin does not sandbox code. Crafty's `write`, `writeErr`, logger, config, and secret scopes are isolated per tool call, but direct process/console writes and client-owned shared mutable state are not. Tool inputs are capped at 4 MiB and 256 argument values; captured output is capped at 1 MiB stdout and 128 KiB diagnostics.

## Describe reusable CLI workflows as skills

When a workflow coordinates one or more CLIs, document it as an agent skill that guides the agent through the installed executables. A skill can select commands, explain the sequence, capture decision points, and state when to stop; it does not make arbitrary CLI calls deterministic or guarantee unattended execution.

For a workflow skill:

- Identify the executable and discover its supported commands and options from `--help` or the CLI's own docs. Treat those as the interface instead of assuming private APIs.
- Preserve argument boundaries with argv arrays or explicit argument lists. Avoid shell composition unless the task requires it and the CLI invocation explicitly uses a shell.
- Explain how to parse `--json` output, including its success/error envelope, result data, and process exit status. For Crafty output, inspect `ok`, `data`, `meta`, and `error`. Do not treat a nonzero exit as success because stdout contains parseable JSON.
- State required dependencies, inputs, write effects, and stopping conditions. Include confirmation flags only for writes authorized by the user or an explicitly invoked skill; a workflow alone does not grant authorization. Stop on failures unless the workflow names a specific recoverable condition and response.
- Use the skill for interactive decisions and checks. Add an ordinary script only when unattended repetition or reproducible execution is required and the steps can be made deterministic; keep its dependencies and failure behavior explicit.

Do not add a second workflow runtime to Crafty for sequencing CLI commands. The framework's in-process `run()` and `runCommand()` APIs remain available for generic nested composition within a client. The command registry and fallback output sink remain process-global; the MCP plugin gives each tool call a separate output, configuration, and secret scope, while client-owned shared mutable state stays the client's responsibility.

## Verify the consumer-facing behavior

Run the actual client entrypoint. Check root and nested help, a successful result in human and JSON modes, an invalid invocation with its exit status, and completion metadata when enabled. For a skills catalog, verify list/show and installer dry-run without launching a real install. Use isolated fixtures for writes or external services. Keep tests for meaningful boundaries, failure behavior, and cleanup, and update the client's command and workflow documentation when its contract changes.
