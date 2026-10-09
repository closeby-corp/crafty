# crafty example client

A small client for the [Crafty framework](../framework/README.md), with five discovered commands, one helper,
and a client-owned workflow skill. It exercises framework discovery, nested routes, a captured parameter,
lifecycle hooks, structured output, and the optional completion and skills plugins.

```text
client/
├── cli.ts                     # start({ commandsDir: new URL('./commands/', import.meta.url) })
├── commands/
│   ├── completion.ts          # re-exports crafty/plugins/completion
│   ├── demo.ts                # nested route, :parameter, init/destroy hooks, ctx.state
│   ├── echo.ts                # positionals, flag, repeatable option, raw -- tail
│   ├── skills.ts              # configures crafty/plugins/skills with this client's skill source
│   └── version.ts             # human and --json renderings of one value
├── skills/
│   └── crafty-example-workflow/SKILL.md
├── lib/manifest.ts            # helper, outside commands/ so discovery ignores it
└── test/example.test.ts       # runs this client's registry in-process
```

## Run it

From the repository root:

```bash
bun install --frozen-lockfile   # installs the framework and this client workspace
cd client
bun run cli --help
bun run cli demo task build show extra --json
bun run cli echo hello --upper --tag one --tag=two -- --not-a-flag
bun run cli version
```

`bun link` exposes the executable named in `bin` (here `crafty`); the entrypoint resolves `commands/` relative
to itself, so the linked executable works from any directory and picks up added or edited command files on the
next invocation.

## What each file shows

- **`demo`** — `demo task <name> show`: the `:name` segment lands in `ctx.params.name`, `init` hooks run
  outermost to innermost and `destroy` in reverse, and hooks hand the handler an object through `ctx.state`.
  Hooks write progress markers only under `--verbose`; `demo task <name> fail` throws a usage error.
- **`echo`** — positional words plus the raw tail after a standalone `--` are printed verbatim; `--upper` is a
  boolean flag and repeated `--tag` values are collected in `ctx.repeat['tag']`.
- **`version`** — one handler, two renderings: `emitResult` prints the envelope under `--json` and a plain
  string otherwise. It reads its version through `lib/manifest.ts`.
- **`completion`** — a one-line re-export of `crafty/plugins/completion`; delete the file to drop the command.
- **`skills`** — opts this client into static skill discovery and explicit installation through the pinned Skills CLI. Its catalog comes from this client's `skills/` directory.
- **`skills/crafty-example-workflow`** — demonstrates using the installed executable, inspecting help, handling JSON envelopes and exit codes, and stopping on unexpected errors.

## Client workflow skills

Keep skills in `skills/<name>/SKILL.md`; the directory name and frontmatter `name` must match. Each skill needs YAML `name` and non-empty `description` fields. A root `SKILL.md` is unsupported. Set `internal: true` in frontmatter to hide a skill from listing, showing, and installation. Catalog discovery rejects symlinks in skill directories, documents, and resources. `list` and `show` read this static catalog without starting a subprocess or contacting a network.

```bash
crafty skills list
crafty skills show crafty-example-workflow
crafty skills show crafty-example-workflow --json
```

The optional installer wraps `bun x --bun skills@1.7.1 add <source>`. Its source is anchored beside this command module, while project installation targets the directory from which `crafty skills install` is invoked. Review the installer help before use:

```bash
crafty skills install --help
crafty skills install --skill crafty-example-workflow --agent codex --copy --dry-run --json
crafty skills install --skill crafty-example-workflow --agent codex --copy --yes
```

Use repeatable `--skill` and `--agent` selections when installing several skills or for several agents. Interactive human terminals can select values in the installer; Crafty preserves the upstream prompts, output, and exit status, which may not reveal a partial failure. For verified install records, pass explicit skill and agent selections with `--yes`. Actual JSON and non-interactive installs require those selections and `--yes`; they request and validate upstream JSON results before reporting success, including installed records and paths. `--global` explicitly selects the user's global agent configuration instead of the current project. `--copy` is forwarded to the Skills CLI, and `--dry-run` previews the delegated request without launching it. A real install may download the pinned package on first use. Installation changes agent skill files; the skill instructions themselves do not grant that permission.

The Skills CLI is pinned at version 1.7.1. Crafty lists and shows local skill files without network access. An actual install delegates to `bun x --bun skills@1.7.1 add` and requires Bun's package execution to be available.

If this client is packaged separately, include its `skills/` directory in the client artifact so the configured catalog and local install source remain available. The framework package intentionally excludes client skill resources.

Business commands belong in a client like this one, not in the framework package. The UQ infrastructure
application (`ops`) is a separate client repository that pins a released framework artifact.

Declare repeatable and sensitive string options on the route that accepts them:

```ts
options: [
  { name: 'tag', type: 'string', repeatable: true },
  { name: 'api-key', type: 'string', sensitive: true },
]
```

Options inherit from ancestors along the selected route. Sibling routes may declare their own flags, but supplying
a flag that is not on the selected route is rejected. Options may appear before or after route words. The `echo`
command uses `repeatable: true` on its `tag` option and exposes each supplied value through `ctx.repeat['tag']`.

## Tests

```bash
bun run test        # this client
bun run typecheck
```

The suite loads this client's own `commands/` directory through `loadCommands`, then asserts routing, hook
order, output envelopes, skills discovery/show, installer help and dry-run behavior, and help behaviour against
the real files. Framework-level unit tests live in [`../framework/test/`](../framework/test/).
