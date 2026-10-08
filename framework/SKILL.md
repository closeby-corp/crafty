---
name: crafty-authoring
description: Create or modify client-owned Crafty CLI commands, optional plugins, and Markdown recipes. Use when adding command routes, arguments, lifecycle hooks, configuration access, completion metadata, or reusable workflows to a Bun client that imports crafty.
---

# Crafty command and recipe authoring

## Scope and sources of truth

Crafty is an installed Bun framework; each client versions its commands and workflows in its own repository. Target the client's installed version and existing conventions, not an imagined API.

This skill ships as `node_modules/crafty/SKILL.md` in Crafty 0.5.0 and newer. Packaging does not register it automatically; copy it into your agent's skill directory when needed.

- See the adjacent [framework contract](README.md) and `src/index.ts` for public exports.
- Framework source and the optional client workspace live in the [Crafty repository](https://github.com/closeby-corp/crafty). The client workspace is not shipped in the package.
- External clients import from `crafty` and documented subpaths, never private source files. Inspect their dependency manifest, entrypoint, helpers, and neighboring commands before editing.

Choose a **command** for a new operation or reusable capability. Choose a **recipe** for a named, parameterized sequence of existing commands with explanatory prose. A recipe composes capabilities; it does not implement a missing command or execute arbitrary shell syntax.

## Locate the client before editing

1. Read `package.json` and the executable entrypoint. Find `start({ commandsDir, program })` and use that CLI name in examples and authored usage.
2. Inspect a neighboring command and relevant client helpers. Reuse the client's configuration, transport, credential, and output conventions.
3. Keep command modules in the designated directory; put helpers in `lib/` and tests in `test/`, and recipe files in the client's recipe directory when that client has one.
4. Keep the framework dependency and lockfile versioned. Do not change the framework for an application-specific operation.

A minimal entrypoint looks like this; `toolbox` is an example client name, not a required name:

```ts
#!/usr/bin/env bun
import { start } from 'crafty'

process.exitCode = await start({
  commandsDir: new URL('./commands/', import.meta.url),
  program: 'toolbox',
})
```

Its manifest uses `"bin": { "toolbox": "./cli.ts" }`. Make the entrypoint executable and run `bun link` from that client only when setting up its executable. Adding or changing commands does not require rebuilding or relinking.

## Author a command module

Discovery imports direct regular `.ts` files in filename order. It ignores declarations, subdirectories, and symlinks. The filename supplies the root command name unless the module sets `name`. Default-export a plain object checked with `satisfies CommandModule`.

For example, create `commands/greet.ts`:

```ts
import { emitResult, flag, option, usageError, type CommandModule } from 'crafty'

export default {
  summary: 'Greet a subject',
  aliases: ['hello'],
  options: [
    { name: 'language', type: 'string', short: 'l', completion: ['en', 'pt'] },
    { name: 'shout', type: 'boolean' },
  ],
  commands: {
    ':subject': {
      run(ctx) {
        if (ctx.positionals.length || ctx.tail.length) {
          throw usageError('expected exactly one subject')
        }
        const language = option(ctx.values, 'language') ?? 'en'
        if (language !== 'en' && language !== 'pt') {
          throw usageError('--language must be en or pt')
        }
        const greeting = `${language === 'pt' ? 'Olá' : 'Hello'}, ${ctx.params.subject}`
        emitResult(ctx, {
          greeting: flag(ctx.values, 'shout') ? greeting.toUpperCase() : greeting,
        })
      },
    },
  },
} satisfies CommandModule
```

Run it through the client: `bun run cli.ts greet Ada --language pt --shout --json`.

### Routing and arguments

- Each node has either a `run` handler or nonempty `commands`, never both. A child function is leaf-handler shorthand.
- Use static child keys for verbs and `:parameter` keys for routed identifiers. At most one dynamic child per sibling set; static names and aliases win over it. Parameter names cannot repeat along a path.
- Read captured route values from `ctx.params`; `ctx.positionals` contains arguments left after routing. Validate their count and meaning explicitly.
- Declare flags in `options`. Only `boolean` and `string` types exist; parse and validate numeric/string domains yourself. `completion` suggests values but does not validate them or supply defaults.
- Use `flag(ctx.values, name)` and `option(ctx.values, name)`. Declare intentionally repeatable options with `repeatable: ['name']` and read their lists from `ctx.repeat`.
- Everything after standalone `--` is untouched in `ctx.tail`. Pass argument arrays to subprocess APIs; do not concatenate untrusted values into shell code.
- Global options already include help, config, JSON, format, color, and verbose controls. Do not repurpose them or create conflicting names/short flags.
- Generated help follows `program` and the selected route. Explicit `usage` strings remain verbatim; update them when the client's CLI name or contract changes.

### Hooks and resources

`init(ctx)` runs outermost to innermost. `destroy(ctx)` runs in reverse, including for a node whose initialization failed. Ancestors and the handler share fresh invocation-local `ctx.state` and `ctx.params`.

Acquire resources in hooks or handlers, not at import time. Store owned resources in `ctx.state` with client-side type narrowing; make teardown safe when acquisition only partially succeeded. Help, invalid routing, and completion metadata lookup do not run target hooks or handlers, but discovery still imports modules.

### Results and failures

- Use `emitResult(ctx, data, meta?)` for structured results and supported output formats. Returning an object does not emit it: handlers return `void` or an integer exit status in 0–255.
- Use `usageError(message, hint?)` for invalid user arguments, `ConfigError(problems, path)` for configuration validation, and `OpsError` with the appropriate kind for explainable operational failures. Let the framework report failures; do not call `process.exit()` inside commands.
- JSON output is committed only after successful teardown. A primary failure or explicit nonzero status takes precedence over cleanup failures.
- Keep progress and diagnostics off result stdout. Use the framework's output/logging helpers and the client's credential-redaction conventions. Never emit credentials in results, hints, or recipe captures.

## Configuration is client-owned

Crafty 0.5.0 recognizes `--config` / `-c` and exposes its selected path through `configPathFromCli()`. It does **not** parse the file, inject `ctx.config`, or offer `start({ configFile })`. The option is stripped before command parsing and is not in `ctx.values`.

Use or extend the client's shared typed loader. The client owns path precedence, environment names, file format, schema validation, and caching. Commands that need configuration call that helper, or a parent hook stores the loaded value in invocation state. Load lazily so help, version, completion, and other config-independent commands remain usable without a configuration file.

Reuse the client's existing configuration loader rather than adding a second one; the UQ ops client uses `lib/targets.ts`. Do not prescribe one client's environment variables, precedence, or schema to another: `OPS_CONFIG` applies to ops only.

## Optional plugins and completion

A plugin registers through an explicit client command module. To enable the shipped completion plugin, create `commands/completion.ts`:

```ts
export { default } from 'crafty/plugins/completion'
```

Removing the wrapper disables it. Do not make optional commands mandatory in framework startup. There is no generic plugin-install API: reuse client imports/default exports and declare any third-party dependencies in the client manifest.

Add enum, file, directory, or lazy provider metadata to relevant string options. In Crafty 0.5.0 and newer, `completion` also accepts `(ctx: CompletionContext) => readonly string[] | Promise<readonly string[]>`; a dynamic `:parameter` child can declare the same array/provider on its own `completion` field. Providers receive `configPath`, captured `params`, `prefix`, `index`, and `words` through the cursor. Reuse the client's loader and pass `ctx.configPath` explicitly: the completion query transports target arguments after `--`, so `configPathFromCli()` does not see that override. Parent options are inherited; route-local declarations override their value metadata. Installed 0.4.0 clients must update their framework dependency before using providers.

Providers run lazily for the requested value, without target hooks or handlers. Return only public identifiers, never secrets, and do not write stdout. Dynamic route values are not fetched automatically. Keep import-time code free of filesystem writes, network calls, credential reads, and resource acquisition: completion queries import all command modules.

`<cli> completion install --shell bash|zsh` explicitly modifies the user's shell startup file. Do not run installation as part of command development; use an isolated home for installer verification.

## Author recipes only where the client supports them

Recipes are client policy. The UQ infrastructure client at `~/uq/uq-infra-support/infra/services/ops-cli` provides `recipe list`, `recipe show`, and `recipe run` from its own `commands/recipe.ts` and `lib/recipes/engine.ts`. The contract below describes that engine. Crafty 0.5.0 does not export `crafty/plugins/recipe`. A client must already provide a compatible recipe command/engine before these instructions apply; do not invent that import or assume installing Crafty enables recipes.

Treat a recipe as a versioned runbook: executable steps in YAML front matter, purpose and operational caveats in Markdown prose. Keep domain operations in commands so they remain independently callable, testable, and composable.

### Front matter and composition

A recipe file starts with `---`, contains the front matter below, then closes with `---`. Only `name`, `description`, `params`, and `steps` are allowed at the top level.

This example composes the `greet` command above. Save it as `recipes/greeting-workflow.md` in a client that provides both commands:

```markdown
---
name: greeting-workflow
description: Greet a subject in Portuguese, then reuse the greeting
params:
  subject:
    default: Ada
    description: Subject to greet
steps:
  - id: first
    run: [greet, "{{params.subject}}", --language, pt, --json]
  - id: followup
    run: [greet, "{{steps.first.json.data.greeting}}", --json]
---
# Greeting workflow

Both steps are local and read-only. The second step consumes the first
step's JSON result as one argument, including its spaces.
```

- A parameter is a scalar default, or a table containing only `default` and/or `description`. Without a default it requires `--param name=value`; overrides are strings. Unknown or missing parameters are usage errors.
- Each step has a unique nonempty `id` and a `run` string or argument list. Optional `quiet` and `continue_on_error` fields are booleans; other fields are rejected.
- Prefer argument lists for unambiguous boundaries. String form supports tokenizing quotes and escapes, not shell execution. No pipes, redirects, glob expansion, environment assignments, or `&&`.
- Substitution happens after tokenization, within each argument. A value containing spaces remains one argument. Commands that explicitly invoke a shell still require their own input-safety policy.
- Use bare command roots in recipes for portability. The ops engine strips a leading `ops`, not arbitrary custom CLI names.
- Steps dispatch in-process through the same command executor as direct invocations, including parsing and hooks. They must reference known commands and cannot invoke another recipe.
- Unknown keys, invalid commands, duplicate step IDs, unknown parameters, and forward step references fail recipe loading. Do not hide a malformed recipe behind tolerant execution.

| Placeholder | Value |
| --- | --- |
| `{{params.subject}}` | Declared parameter, resolved from override or default |
| `{{steps.first.stdout}}` | Earlier step's captured stdout, trailing whitespace trimmed |
| `{{steps.first.json.data.greeting}}` | Field from an earlier step's JSON stdout; give that step `--json` |
| `{{steps.first.json.data.rows.0}}` | Dotted JSON traversal, including numeric array indices |
| `{{steps.first.exit_code}}` | Earlier step's exit code |
| `\{{` | Literal opening braces |

### Discovery, execution, and verification

The UQ infrastructure client's discovery precedence is: repeated `--recipes-dir` directories in argument order, `$OPS_RECIPES_DIR`, `~/.config/ops-cli/recipes`, then its shipped `recipes/`. Directories are scanned recursively for Markdown files. Across directories the first recipe name wins; duplicate names within one directory are errors. Missing directories are skipped. These paths/environment names are client policy, not framework defaults.

Use the actual client's CLI name:

```bash
bun run cli.ts recipe list --recipes-dir ./recipes
bun run cli.ts recipe show greeting-workflow --recipes-dir ./recipes
bun run cli.ts recipe run greeting-workflow --recipes-dir ./recipes --param 'subject=Ada Lovelace' --dry-run
bun run cli.ts recipe run greeting-workflow --recipes-dir ./recipes --param 'subject=Ada Lovelace' --json
```

`--dry-run` resolves parameters but leaves earlier-step placeholders literal; it executes nothing and cannot prove a later JSON path exists. Follow it with a safe real execution. For this example, expect two successful steps; their captured JSON results contain `Olá, Ada Lovelace` and `Hello, Olá, Ada Lovelace`, respectively.

Execution stops at the first failed step and returns its exit status unless that step declares `continue_on_error: true`. Tolerated failures remain recorded, with their IDs in the recipe envelope's `meta.tolerated`; an entirely successful/tolerated run exits 0. Use tolerance only for explicitly nonfatal operations, not to disguise a broken workflow. `quiet` suppresses human-mode output echo, not result capture.

Recipes do not bypass write confirmation. Recipe-level `--yes` is passed only to commands that declare a `yes` option. Do not add it automatically; document write effects and verify read-only paths or isolated fixtures first.

Inspect the recipe envelope's step `argv`, `exit_code`, and `stdout`, not just the aggregate status. Also check a missing/unknown parameter and relevant failure behavior. Use isolated recipe directories and home/environment settings for smoke runs: `--recipes-dir` changes precedence but does not disable scanning fallback directories.

## Verify the consumer-visible behavior

1. Run the actual client entrypoint, not only an imported handler. Check root/nested help, the intended result, JSON output, and at least one invalid input with its exit status.
2. For the example: `greet Ada --language pt --shout --json` returns a success envelope with `data.greeting` equal to `OLÁ, ADA`; `greet Ada --language fr --json` exits 2 with a usage error. The `hello` alias should invoke the same route.
3. If completion is enabled, query its metadata, for example `bun run cli.ts completion query --index 4 -- toolbox greet Ada --language ''`. Expect the declared language values without running the greeting handler.
4. Run the client's existing typecheck and relevant behavioral tests. In this repository, `bun run typecheck` checks both workspaces. Keep regression tests for uncertain behavior, boundaries, errors, or lifecycle cleanup—not source wording or wiring.
5. Update the client's usage/config/recipe documentation for changed contracts. Remove temporary smoke fixtures and never change real credentials, infrastructure, shell startup files, or global executable links just to verify an example.
