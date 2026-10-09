# crafty example client

A small client for the [Crafty framework](../framework/README.md): four command files, one helper, and the
tests that cover them. It is the executable proof that a client consumes the installed framework — discovery,
nested routes, a captured parameter, lifecycle hooks, structured output, and the optional completion plugin —
without any framework code living in the client.

```text
client/
├── cli.ts                     # start({ commandsDir: new URL('./commands/', import.meta.url) })
├── commands/
│   ├── completion.ts          # re-exports crafty/plugins/completion
│   ├── demo.ts                # nested route, :parameter, init/destroy hooks, ctx.state
│   ├── echo.ts                # positionals, flag, repeatable option, raw -- tail
│   └── version.ts             # human and --json renderings of one value
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
  boolean flag and `--tag` is declared `repeatable`, so `ctx.repeat['tag']` collects every occurrence.
- **`version`** — one handler, two renderings: `emitResult` prints the envelope under `--json` and a plain
  string otherwise. It reads its version through `lib/manifest.ts`.
- **`completion`** — a one-line re-export of `crafty/plugins/completion`; delete the file to drop the command.

Business commands belong in a client like this one, not in the framework package. The UQ infrastructure
application (`ops`) is a separate client repository that pins a released framework artifact.

## Tests

```bash
bun run test        # this client
bun run typecheck
```

The suite loads this client's own `commands/` directory through `loadCommands`, then asserts routing, hook
order, output envelopes, and help behaviour against the real files. Framework-level unit tests live in
[`../framework/test/`](../framework/test/).
