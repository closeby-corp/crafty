# Crafty

A Bun command framework with client-owned TypeScript commands. This repository contains two packages, not two repositories:

```text
crafty/
├── package.json       # private workspace container
├── bun.lock           # shared dependency lockfile
├── framework/         # installable crafty package, version 0.8.0
│   ├── SKILL.md       # packaged command and CLI workflow authoring guidance
│   ├── src/
│   └── test/
└── client/            # small example client
    ├── cli.ts         # executable named crafty
    ├── commands/      # demo, echo, version + optional completion, skills, updates and MCP plugins
    ├── skills/        # client-owned agent workflow skills
    ├── lib/           # helper, kept outside commands/ so discovery ignores it
    └── test/
```

Requires Bun >= 1.4. The framework supplies command routing, arguments, help, lifecycle hooks, context, and structured output/errors. It ships no integration commands or executable: a client owns those and imports the framework through its installed `crafty` dependency.

The UQ infrastructure client runs in `~/uq/uq-infra-support/infra/services/ops-cli`, with the executable name `ops`. Its command files are owned by that repository and its framework dependency is a pinned package artifact — not a workspace link to this checkout. The `client/` here is an example client: it exercises command discovery, nested routes, a captured parameter, lifecycle hooks, output, and optional completion, skills, repository updates, and HTTP MCP plugins. It also carries a client-owned workflow skill for using the example CLI.

## Run and link the example client

From the repository root:

```bash
bun install --frozen-lockfile
cd client
bun run cli --help
bun run cli demo task build show extra --json
bun run cli mcp serve --help
bun link
```

With Bun's global bin directory on `PATH`, `crafty --help` works from any directory. The linked entrypoint anchors command discovery to this client's `commands/`, not the invocation directory.

Add, edit, or remove a valid command module there and the next invocation sees the change. No rebuild, reinstall, or relink is needed for command changes. Helpers and tests belong outside `commands/`.

The example client uses a Bun workspace dependency on Crafty. Framework and commands are versioned together by this repository's Git history. An independent client can pin the published framework tarball and version its command files separately. `bun link` links the client's executable; no global framework installation is required.

Linking another executable with the same name can replace the existing link. Use distinct executable names for multiple clients. `bun unlink` unregisters a client package.

## Dynamic Bash and Zsh completion

The example client enables the optional standard plugin in `client/commands/completion.ts`:

```ts
export { default } from 'crafty/plugins/completion'
```

Install registration once and then open a new shell:

```bash
crafty completion install                # detect Bash/Zsh from $SHELL
crafty completion install --shell bash   # explicitly choose Bash 4+
crafty completion install --shell zsh
```

The installer appends a per-executable block to `~/.bashrc` or `${ZDOTDIR-$HOME}/.zshrc` (Zsh uses `$HOME` only when `ZDOTDIR` is unset). Repeating the command does not add duplicate blocks. Existing contents, permissions, and startup-file symlinks are preserved. Zsh initializes `compinit` only if needed. Missing executables are skipped at startup. Bash reads `.bashrc` in interactive non-login shells; for interactive login shells, the installer reports a shell-quoted `source ~/.bashrc` equivalent to add to the login profile if that profile does not already source `.bashrc`. The notice is shown to humans and included in the JSON result as `activation`.

Use your client's CLI name instead of `crafty`, for example `ops completion install`. Multiple executable registrations coexist. Only `completion install` edits startup files; `completion bash` and `completion zsh` still print adapters for manual sourcing. To remove registration, delete that executable's marked block from the startup file.

The installer is available in Crafty 0.4.0 and newer. Manual registration also works: for Bash, add `source <(crafty completion bash)` to `~/.bashrc`; for Zsh, add `source <(crafty completion zsh)` after `compinit` in `~/.zshrc`.

Each Tab request queries the linked client for fresh command metadata and declared value providers. New, edited, and removed command modules appear immediately without re-sourcing, rebuilding, or relinking. Completion covers command names/aliases, nested routes, explicit enums, declared file/directory inputs, and client-provided configuration-backed option/parameter values. Flag names are not suggested, even after a dash prefix; values still complete for options typed explicitly. It does not infer configuration schemas or contact infrastructure APIs automatically.

Target handlers and lifecycle hooks do not run during metadata lookup, but command modules are still imported. Keep import-time code free of side effects. See the [framework completion contract](framework/README.md#optional-completion-plugin) for value metadata and registration details.

## Serve configured commands over HTTP MCP

The example client opts into `crafty/plugins/mcp` through `client/commands/mcp.ts`. Run `crafty mcp serve` to expose its configured leaf commands at `http://127.0.0.1:8787/mcp`. The server uses the same handlers and selected config path as the CLI. Non-loopback bindings require bearer auth, TLS, and Host allowlisting; unclassified and write routes require an explicit server environment setting. See the [framework MCP contract](framework/README.md#optional-http-mcp-plugin) for route policies and tool schemas.

## Update a client CLI repository

The example opts into `crafty/plugins/update` in `client/commands/update.ts`. An independent client should point `repositoryDir` at the Git repository that owns its executable and commands. `crafty update --check` reports available commits, and `crafty update` fast-forwards the configured upstream only when the checkout is clean. Interactive commands show a throttled update notice; GitHub checks use `gh api` when possible. The updater does not install dependencies or restart the process. See the [framework update contract](framework/README.md#optional-client-update-plugin) for configuration and safeguards.


## Install Crafty in another client

Only the framework is packaged. Install the versioned GitHub release asset:

```bash
bun add https://github.com/closeby-corp/crafty/releases/download/v0.8.0/crafty-0.8.0.tgz
```

Crafty is not published to npm. The repository root is a private workspace container, not the framework package. See the [framework README](framework/README.md) for the minimal client entrypoint, public API, and command contract. See the [example client README](client/README.md) for a client using that contract.

For agent-assisted command authoring or workflows built around client CLIs, use [`framework/SKILL.md`](framework/SKILL.md), also shipped as `node_modules/crafty/SKILL.md` and exposed as `crafty/SKILL.md`. It covers client discovery, command contracts, configuration access, optional plugins, and how a skill can guide workflows through installed executables. The framework package contains only this authoring skill; client workflow skills stay in each client's `skills/` directory. Packaging either source tree does not automatically register skills with an agent.

## Development

```bash
bun install --frozen-lockfile
bun run test          # framework and example-client suites
bun run typecheck     # framework and example-client TypeScript checks
bun run pack          # framework/crafty-0.8.0.tgz
```

The framework package's allowlist contains `src/` and `SKILL.md`; standard package metadata and its README are included. The example client and its client-only skills, assets, and dependencies are excluded from the framework artifact. Client releases that distribute their own CLI may include that client's `skills/` resources. The old compiled launcher and source-tree installation layout are removed; clients execute through Bun and their installed framework.

`bun run test` includes a packed-consumer check that installs the tarball in a temporary client and exercises the public package from another working directory. CI runs install, tests, and typecheck on Ubuntu, macOS, and Windows with Bun 1.4.2. Bash completion integration is POSIX-only and runs with Bash 4+; core and packed-consumer checks also run on Windows.

## 0.8.0

- Added the opt-in `crafty/plugins/update` updater with clean-worktree checks, fast-forward-only Git updates, rate-limited interactive notices, and optional GitHub CLI comparisons.
- Added command-module startup hooks for opt-in plugins that need to inspect each CLI invocation.
- Verified with 109 framework tests, 10 example-client tests, both typechecks, and the packed-consumer check.

## 0.7.0

- Added the opt-in `crafty/plugins/mcp` HTTP MCP server over Streamable HTTP, with loopback defaults, Host/Origin checks, remote TLS and bearer-auth requirements, per-call output/config/secret scopes, and server-side write authorization.
- Added route-level MCP exposure policies, conservative tool schemas, request/output limits, and regression coverage for protected route shadowing, prototype-spelled parameters, and modern browser CORS.
- Verified with 105 framework tests, 10 example-client tests, both typechecks, and the packed-consumer check.

## 0.6.0

- Added the optional client-owned skills catalog and installer plugin, backed by pinned `skills@1.7.1`.
- Added repeatable and sensitive option metadata, selected-route validation, and additional preview redaction.
- Improved config scoping, logger output, and Bash/Zsh completion portability.
- Verified: 101 framework tests, 10 example-client tests, both typechecks, skill validation, and an actual temporary-project skill installation.

## 0.5.1

- Removed flag-name suggestions, including after a dash prefix, while preserving commands, configured route identifiers, and values for explicitly typed options.
- Updated the packaged skill to describe flag-free completion.
- Verified: 50 framework tests, 8 example-client tests, both typechecks, CLI queries, and actual Bash Tab interactions with no flag suggestions.

## 0.5.0

- Added lazy synchronous/asynchronous completion providers for configuration-backed option values and dynamic route parameters.
- Providers receive the selected configuration path and captured parameters; inherited options respect route-local value metadata.
- Included the command/recipe authoring skill in the framework package as `SKILL.md`, exposed as `crafty/SKILL.md`.
- Verified: 50 framework tests, 8 example-client tests, both typechecks, CLI queries, and actual Bash Tab interactions using isolated configuration files.

## 0.4.0

- Added explicit `completion install` to the existing optional completion plugin: Bash/Zsh detection, `--shell`, idempotent per-CLI startup registration, and `ZDOTDIR` support.
- Preserved existing startup contents, permissions, and symlinks; edited/incomplete managed blocks are rejected rather than overwritten.
- Released the completion installer as a versioned GitHub package asset for independent clients, including UQ's `ops` CLI.

Verified: 45 framework tests, 367 client tests, both typechecks, and fresh interactive Bash/Zsh shells using isolated startup files. Actual Tab interactions exercised multiple CLI names and newly added commands without reinstalling. The user's startup files were not modified.

Re-checked after `client/` was reduced to a four-command example: `bun run test` (45 framework, 8 example-client tests), `bun run typecheck`, and `bun run pack` passed, and the packed allowlist contained only the framework's `src/` plus its manifest and README. The example client ran from an unrelated working directory and through an isolated `bun link`; a command module dropped into `client/commands/` after the last pack was discovered without rebuilding or relinking, and its hooks ran outermost to innermost with reverse teardown. Completion metadata reflected the live registry, and `completion install` stayed idempotent against isolated startup files. At that time, the separate UQ `ops` client (363 tests, framework copy byte-identical to `framework/src`) returned exact rows from a throwaway PostgreSQL 16 fixture for `db sd query events 'id=1'` and `db all query …`, refused multi-statement SQL with its seed rows intact, kept an unknown alias a usage error without connecting, and captured its recipe steps as separate envelopes.

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
