# Crafty

A Bun command framework with client-owned TypeScript commands. This repository contains two packages, not two repositories:

```text
crafty/
├── package.json       # private workspace container
├── bun.lock           # shared dependency lockfile
├── framework/         # installable crafty package, version 0.3.0
│   ├── src/
│   └── test/
└── client/            # optional infrastructure application
    ├── cli.ts         # executable named crafty
    ├── commands/      # existing command modules + optional completion plugin
    ├── lib/           # integration helpers
    ├── recipes/
    ├── config.example.yml
    └── test/
```

Requires Bun >= 1.4. The framework supplies command routing, arguments, help, lifecycle hooks, context, and structured output/errors. It ships no integration commands or executable. The optional client owns those commands and imports the framework through its installed `crafty` dependency.

## Run and link the included client

From the repository root:

```bash
bun install --frozen-lockfile
cd client
bun run cli --help
bun link
```

With Bun's global bin directory on `PATH`, `crafty --help` works from any directory. The linked entrypoint anchors command discovery to this client's `commands/`, not the invocation directory.

Add, edit, or remove a valid command module there and the next invocation sees the change. No rebuild, reinstall, or relink is needed for command changes. Helpers and tests belong outside `commands/`.

The included client uses a Bun workspace dependency on Crafty. Framework and commands are versioned together by this repository's Git history. An independent client can pin the published framework tarball and version its command files separately. `bun link` links the client's executable; no global framework installation is required.

Linking another executable with the same name can replace the existing link. Use distinct executable names for multiple clients. `bun unlink` unregisters a client package.

## Dynamic Bash and Zsh completion

The included client enables the optional standard plugin in `client/commands/completion.ts`:

```ts
export { default } from 'crafty/plugins/completion'
```

For Bash 4 or newer, add this line to `~/.bashrc`:

```bash
source <(crafty completion bash)
```

For Zsh, source the adapter after completion initialization in `~/.zshrc`:

```zsh
autoload -Uz compinit
compinit
source <(crafty completion zsh)
```

If your Zsh setup already runs `compinit`, keep that initialization and add only the source line after it. Crafty prints registration scripts; it never edits shell startup files.

Each Tab request queries the linked client for fresh command metadata. New, edited, and removed command modules appear immediately without re-sourcing, rebuilding, or relinking. Completion covers command names/aliases, nested static routes, inherited flags, explicit enum values, and declared file/directory inputs. It does not infer values for dynamic route parameters or contact infrastructure APIs.

Target handlers and lifecycle hooks do not run during metadata lookup, but command modules are still imported. Keep import-time code free of side effects. See the [framework completion contract](framework/README.md#optional-completion-plugin) for value metadata and registration details.


## Install Crafty in another client

Only the framework is packaged. Install the versioned GitHub release asset:

```bash
bun add https://github.com/closeby-corp/crafty/releases/download/v0.3.0/crafty-0.3.0.tgz
```

Crafty is not published to npm. The repository root is a private workspace container, not the framework package. See the [framework README](framework/README.md) for the minimal client entrypoint, public API, and command contract. See the [client README](client/README.md) for the existing integrations and configuration.

## Development

```bash
bun install --frozen-lockfile
bun run test          # framework and client suites
bun run typecheck     # framework and client TypeScript checks
bun run pack          # framework/crafty-0.3.0.tgz
```

The framework package's allowlist contains only its `src/`; standard package metadata and its README are included. Client commands, assets, and integration dependencies are excluded. The old compiled launcher and source-tree installation layout are removed; clients execute through Bun and their installed framework.

## 0.3.0

- Added optional `crafty/plugins/completion` with dynamic Bash and Zsh adapters.
- Added explicit `OptionSpec.completion` metadata for enum, file, and directory values.
- Enabled completion in the included client without making it a mandatory framework command.

Verified: 39 framework tests, 367 client tests, both typechecks, and actual interactive Tab completion in Bash 5.2 and Zsh 5.9. Shell smoke checks covered nested aliases, flags, attached/separate values, quoted prefixes, paths with spaces, literal shell metacharacters, simultaneous client registrations, and live command add/edit/remove. Shell startup files and the user's global links were not modified.

## 0.2.0

- Extracted an installable framework with a public `start({ commandsDir, argv?, program? })` API.
- Moved all existing commands, integration helpers, assets, and integration tests into the optional client workspace.
- Preserved the command-object, nested-routing, lifecycle, and output/error contracts.
- Made command discovery explicit and client-owned; an empty command directory is valid.
- Added per-invocation executable identity for generated help, context, and diagnostics.

Verified with Bun 1.4.2: 24 framework tests and 367 client tests passed, and both typechecks passed. A packed framework was installed into an isolated external client and linked with `bun link`; it ran from `/tmp` and picked up added, edited, and removed commands without rebuilding or relinking. The included linked client resolved its own recipe/config assets from outside the repository. Linking and configuration-write smoke checks used temporary locations, not the user's global executable links or credential files.
