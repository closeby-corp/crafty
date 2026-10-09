---
name: crafty-example-workflow
description: Use the example Crafty client to inspect its CLI, run its echo and demo workflows, and interpret text or JSON results.
---

# Work with the Crafty example client

Use the installed `crafty` executable as the interface. Start with `crafty --help` to discover the commands available in this client, then inspect a command with `crafty <command> --help` before relying on its options. The client currently includes `echo`, `demo`, `version`, `completion`, and `skills`.

For a simple input/output check, run `crafty echo hello world`. Add `--json` when the result needs to be consumed by another step. The JSON success envelope has `ok: true` and puts the command result in `data`; metadata is in `meta`. For example, `crafty echo hello world --json` returns data containing `text: "hello world"`, `tags: []`, and `tail: []`.

To inspect route parameters and lifecycle behavior, run `crafty demo task build show extra --json`. The result's `data.task.name` is `build`, `data.args` contains `extra`, and `data.tail` is empty. `demo task <name> fail` is an intentional example error: it exits nonzero and returns an error envelope with `ok: false` and an `error` object. Treat the process exit status as authoritative even when stdout contains valid JSON. Stop on any unexpected nonzero exit or malformed output; report the error instead of retrying with guessed arguments.

These commands demonstrate a local CLI contract. They do not represent an infrastructure service, mutate remote state, or authorize writes. Do not infer credentials, external services, or approval from the examples.
