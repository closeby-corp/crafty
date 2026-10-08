# Crafty

A Bun command framework with client-owned TypeScript commands. This repository contains two packages, not two repositories:

```text
crafty/
├── package.json       # private workspace container
├── bun.lock           # shared dependency lockfile
├── framework/         # installable crafty package, version 0.5.1
│   ├── SKILL.md       # packaged command and recipe authoring guidance
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

The UQ operations client now also runs independently in `~/uq/uq-infra-support/infra/services/ops-cli`, with the executable name `ops`. Its command files are owned by that repository, and its framework dependency is a pinned package artifact—not a workspace link to this checkout. The included `client/` remains unchanged for now as the existing infrastructure application and compatibility suite.

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

Install registration once and then open a new shell:

```bash
crafty completion install                # detect Bash/Zsh from $SHELL
crafty completion install --shell bash   # explicitly choose Bash 4+
crafty completion install --shell zsh
```

The installer appends a per-executable block to `~/.bashrc` or `${ZDOTDIR-$HOME}/.zshrc` (Zsh uses `$HOME` only when `ZDOTDIR` is unset). Repeating the command does not add duplicate blocks. Existing contents, permissions, and startup-file symlinks are preserved. Zsh initializes `compinit` only if needed. Missing executables are skipped at startup.

Use your client's CLI name instead of `crafty`, for example `ops completion install`. Multiple executable registrations coexist. Only `completion install` edits startup files; `completion bash` and `completion zsh` still print adapters for manual sourcing. To remove registration, delete that executable's marked block from the startup file.

The installer is available in Crafty 0.4.0 and newer. Manual registration also works: for Bash, add `source <(crafty completion bash)` to `~/.bashrc`; for Zsh, add `source <(crafty completion zsh)` after `compinit` in `~/.zshrc`.

Each Tab request queries the linked client for fresh command metadata and declared value providers. New, edited, and removed command modules appear immediately without re-sourcing, rebuilding, or relinking. Completion covers command names/aliases, nested routes, explicit enums, declared file/directory inputs, and client-provided configuration-backed option/parameter values. Flag names are not suggested, even after a dash prefix; values still complete for options typed explicitly. It does not infer configuration schemas or contact infrastructure APIs automatically.

Target handlers and lifecycle hooks do not run during metadata lookup, but command modules are still imported. Keep import-time code free of side effects. See the [framework completion contract](framework/README.md#optional-completion-plugin) for value metadata and registration details.


## Install Crafty in another client

Only the framework is packaged. Install the versioned GitHub release asset:

```bash
bun add https://github.com/closeby-corp/crafty/releases/download/v0.5.1/crafty-0.5.1.tgz
```

Crafty is not published to npm. The repository root is a private workspace container, not the framework package. See the [framework README](framework/README.md) for the minimal client entrypoint, public API, and command contract. See the [client README](client/README.md) for the existing integrations and configuration.

For agent-assisted command and recipe creation, use [`framework/SKILL.md`](framework/SKILL.md), also shipped as `node_modules/crafty/SKILL.md` and exposed as `crafty/SKILL.md`. It covers client discovery, command contracts, configuration access, optional plugins, and the Markdown recipe format for clients that provide a recipe engine. Packaging does not automatically register the skill with an agent.

## Development

```bash
bun install --frozen-lockfile
bun run test          # framework and client suites
bun run typecheck     # framework and client TypeScript checks
bun run pack          # framework/crafty-0.5.1.tgz
```

The framework package's allowlist contains `src/` and `SKILL.md`; standard package metadata and its README are included. Client commands, assets, and integration dependencies are excluded. The old compiled launcher and source-tree installation layout are removed; clients execute through Bun and their installed framework.

## 0.5.1

- Removed flag-name suggestions, including after a dash prefix, while preserving commands, configured route identifiers, and values for explicitly typed options.
- Updated the packaged skill to describe flag-free completion.

Verified: framework and client behavioral suites, both typechecks, CLI queries, and actual Bash Tab interactions with no flag suggestions.

## 0.5.0

- Added lazy synchronous/asynchronous completion providers for configuration-backed option values and dynamic route parameters.
- Providers receive the selected configuration path and captured parameters; inherited options respect route-local value metadata.
- Included the command/recipe authoring skill in the framework package as `SKILL.md`, exposed as `crafty/SKILL.md`.

Verified: 50 framework tests, both workspace typechecks, CLI queries, actual Bash Tab interactions, and an isolated installed-package consumer exercising skill resolution, configured values, and live configuration refresh.

## 0.4.0

- Added explicit `completion install` to the existing optional completion plugin: Bash/Zsh detection, `--shell`, idempotent per-CLI startup registration, and `ZDOTDIR` support.
- Preserved existing startup contents, permissions, and symlinks; edited/incomplete managed blocks are rejected rather than overwritten.
- Released the completion installer as a versioned GitHub package asset for independent clients, including UQ's `ops` CLI.

Verified: 45 framework tests, 367 client tests, both typechecks, and fresh interactive Bash/Zsh shells using isolated startup files. Actual Tab interactions exercised multiple CLI names and newly added commands without reinstalling. The user's startup files were not modified.

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
