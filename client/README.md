# crafty - one CLI in front of the infrastructure

Reaching UQ infrastructure used to mean hand-assembled `ssh` + `docker logs` + `aws` + `curl` invocations scattered
across shell history, each with its own flags and its own output shape. `crafty` fronts every data source with one
option set, one row shape and one JSON envelope:

| Group | What it reaches |
|---|---|
| `crafty ssh` | the VMs from `~/.ssh/config`: commands, container logs, journald, files, disk, load |
| `crafty recipe` | guided procedures that chain the other groups |
| `crafty db` | read-only Postgres SQL over the databases the config file lists, one statement or a join across several |
| `crafty opensearch` (`os`) | cluster health, indices, mappings, Search DSL queries |
| `crafty kibana` | status, spaces, saved objects, console-proxy searches |
| `crafty signoz` | ClickHouse over ssh: databases, tables, SQL, log search |
| `crafty prometheus` (`prom`) | PromQL instant and range queries, labels, targets, rules, alerts |
| `crafty grafana` | health, datasources, dashboards, annotations, datasource queries |
| `crafty bb` | Bitbucket Cloud: repositories, pipelines, pull requests, branches, the local clone |
| `crafty jira` | boards, sprints, issues, comments, labels, transitions |
| `crafty doctor` | one probe per configured source |
| `crafty config` | where settings come from, and how to write a starting file |
| `crafty version` | the version and the Bun it runs on |

This is the optional client application in `client/`, not part of the installable Crafty framework. Its commands, integration helpers, configuration template, and recipes are versioned here. `crafty version` reports this client's version, independently of the installed framework version.

## Install

```bash
bun install --frozen-lockfile  # from the repository root; installs both workspaces
cd client
bun run cli --help
bun link                 # exposes this client's crafty executable
crafty --help
```

Requires Bun >= 1.4 (the CLI uses `Bun.spawn`, `Bun.file`, `Bun.YAML`, and built-in `fetch`).
Commands that reach a host require `openssh-client` on PATH; database queries require the
`duckdb` executable. Credentials come from environment variables or the config file,
not `Bun.secrets`; database queries use DuckDB, not `Bun.SQL`.

The client entrypoint imports its locally installed Crafty dependency and selects
`commands/` relative to itself. The dependency is `workspace:*` on the sibling
`framework/` package; no global framework installation or compiled binary is required.
The linked executable works independently of the invocation's working directory.
Ensure Bun's global bin directory is on PATH. `bun unlink` unregisters this client.

## Shell completion

This client enables the optional `crafty/plugins/completion` module through `commands/completion.ts`.

Bash 4+: add `source <(crafty completion bash)` to `~/.bashrc`.

Zsh: add `source <(crafty completion zsh)` to `~/.zshrc` after your existing `compinit` initialization. If completion is not initialized, run `autoload -Uz compinit; compinit` first.

Suggestions query this client's current command metadata on each Tab press. Adding, editing, or removing command modules does not require regenerating scripts or restarting the shell. Root/nested commands, aliases, flags, format values, and explicitly marked local file/directory inputs are supported. Infrastructure values are not fetched automatically, and target handlers/hooks are not executed.

The scripts are printed to stdout; Crafty does not modify startup files. Remove `commands/completion.ts` if this client should not expose completion.


## Command modules

At each launch, Crafty imports direct regular `.ts` files in this client's `commands/`, in filename order.
Declaration files and subdirectories are ignored; keep helpers outside that directory.
Each file default-exports a plain object; its basename is the root name unless `name` overrides it.
An invalid module or colliding root name/alias fails discovery without replacing the active registry.
Adding, editing, or removing a command file does not require rebuilding or relinking.

```ts
import { emitResult, type CommandModule } from 'crafty'

export default {
  commands: {
    group: {
      commands: {
        ':subject': {
          commands: {
            query(ctx) {
              emitResult(ctx, { subject: ctx.params.subject, args: ctx.positionals })
            },
          },
        },
      },
    },
  },
} satisfies CommandModule
```

Saved as `commands/example.ts`, this runs as `crafty example group sd query events`.
Child keys name routes; function children are leaf-handler shorthand. A node has either
`run` or a nonempty `commands`, not both. Static names and aliases take precedence over
one `:parameter` child per group. The leaf receives only the remaining positional arguments;
tokens after standalone `--` remain untouched in `ctx.tail`.

Optional `init(ctx)` hooks run outermost to innermost; optional `destroy(ctx)` hooks run
in reverse order, including teardown of a node whose initialization failed. All selected
hooks and the handler share one context, with fresh `params` and `state` records for each
invocation. Use `ctx.state` for invocation-owned resources, not module globals.
Help, incomplete routes, and unknown routes never run hooks.

Handlers return nothing for exit 0, or an integer in 0–255. Return values are never serialized;
use the existing output helpers. JSON framework output commits only after successful teardown.
A primary failure or explicit nonzero status wins over cleanup failures.
`crafty help db sd query` and `crafty db sd query --help` select the same leaf help.

## Configure

`crafty config init` writes the commented example below to `~/.config/ops-cli/config.yml` (**0600**). The resolution
order is `--config`, then `$OPS_CONFIG`, then `$XDG_CONFIG_HOME/ops-cli/config.yml`, then
`~/.config/ops-cli/config.yml`; `crafty config path` prints the winner.

One file holds everything: the settings, the sources, **their credentials**, and the field catalog that makes a query
mean the right thing (`log_level` rather than `level`, `uq-production-*` for EKS, the line text in `log`).

Fill in before using a source:

- each target names its credential in one of three ways: `password:` (basic auth), `token:` (bearer), or
  `secret: <key>` when the value lives in the store or the environment instead.
- `targets.kibana-iag.username` is `REPLACE`: only reachable over the VPN as of 2026-10-07.
- `targets.prometheus-bi.base_url` / `targets.grafana-bi.base_url`: the BI vhosts resolve but served the CapRover
  default page when this was written, so confirm the app is live before trusting a probe. Both carry
  `tls_insecure: true`, because that CapRover certificate is self-signed - the only two targets that need it (the
  OpenSearch clusters verify against this machine's trust store). If they live in the EKS
  clusters instead, change `base_url` - no code change.
- `targets.apps.databases`: the databases `crafty db` may read - a name a statement can address, and the
  connector string that reaches it, exactly as you would give `psql` (password included, percent-encoded where a
  Postgres URI encodes one: `@` -> `%40`, `$` -> `%24`). Every connection is opened read-only and nothing else
  resolves the credential, so these targets have no `secret:` key and nothing to store: `agg`/`dt`/`sd` are
  self-hosted, `mm`/`om` share one AWS Aurora instance (RDS).

```yaml
# crafty - one file: every source, its credentials, and the defaults that make
# a query mean the right thing. `crafty config init` writes this to
# ~/.config/ops-cli/config.yml (0600, because it holds the tokens).
#
# A credential is written here (`password:` for basic, `token:` for bearer), or
# named as `secret: <key>`, which is the name of an environment variable
# (`OPS_SECRET_<KEY>`) that may hold it instead - export it there, for CI.
# Values marked REPLACE are the ones this machine still needs. A `db` target is
# the exception: its connector strings carry the password themselves, so there is
# no store key and no REPLACE to fill in elsewhere.
#
# `tls_insecure: true` accepts a certificate this machine does not trust (private
# CA or self-signed). Use it only where that is the actual situation: the
# OpenSearch clusters below verify, so they do not need it.

settings:
  timeout_ms: 15000              # HTTP and ssh timeout, per request
  db_timeout_ms: 60000           # `crafty db` statement budget, before per-database timeouts
  git_timeout_ms: 600000         # `bb` clone / commit / push budget
  max_rows: 200                  # client-side row cap for row-set verbs
  data_dir: ~/.cache/ops-cli     # repo clones, recipe run logs
  # git_author: "Ops Bot <ops@example.com>"

  default_targets:               # used when a verb omits <target>
    opensearch: opensearch-staging
    db: apps
    kibana: kibana-iag
    signoz: signoz
    prometheus: prometheus-bi
    grafana: grafana-bi
    bitbucket: bitbucket
    jira: jira

ssh:
  # Only used by `crafty doctor` and `ssh run --all`.
  hosts:
    - uq-observability
    - uq-ingress-controller
    - uq-bi-worker

targets:
  # ---------------------------------------------------------------- OpenSearch
  # The documented production cluster: private CA (trusted on this machine, no
  # TLS bypass needed), EKS index family, text in `log`. Its credential is the
  # FGAC user; `admin` also works.
  os-prod:
    kind: opensearch
    base_url: https://opensearch.production.uq-systems.net
    auth: basic
    username: admin
    password: REPLACE
    time_field: "@timestamp"
    default_index: uq-production-*

  # The AWS-managed staging/production domains, reachable from the VPC/VPN.
  opensearch-staging:
    kind: opensearch
    base_url: https://vpc-opensearch-staging-gqzdjurwprdwwbv2xyyasfodt4.eu-west-3.es.amazonaws.com
    auth: basic
    username: ops-readonly
    password: REPLACE
    time_field: "@timestamp"
    default_index: "*"

  opensearch-production:
    kind: opensearch
    base_url: https://vpc-opensearch-production-45afc7uijr7rc2q62gvguhoahy.eu-west-3.es.amazonaws.com
    auth: basic
    username: ops-readonly
    password: REPLACE
    time_field: "@timestamp"

  # ------------------------------------------------------------------- Kibana
  # On-prem logback triage. The internal name needs the corporate DNS, which the
  # VPN does not push today.
  kibana-iag:
    kind: kibana
    base_url: https://development-kibana.iag-bsa.com
    auth: basic
    username: REPLACE
    password: REPLACE
    # tls_insecure: true       # uncomment if this certificate is not trusted
    # The catalog's logback family, and the field the level lives in: `level`
    # returns nothing, `log_level` is the one that works.
    default_index: logstash-production-logback-*
    level_field: log_level
    text_fields:
      - message
      - log_level

  # ------------------------------------------------------- SigNoz (ClickHouse)
  signoz:
    kind: signoz
    via: ssh
    ssh_host: uq-observability
    container: signoz-clickhouse
    database: signoz_logs
    logs_table: logs_v2
    time_column: timestamp

  # ------------------------------------------------- Prometheus / Grafana (BI)
  # The BI vhosts still serve the CapRover default page behind a self-signed
  # certificate; point these at the real app when you know its URL.
  prometheus-bi:
    kind: prometheus
    base_url: https://prometheus.prod.bi.uq-systems.net
    auth: none
    tls_insecure: true             # self-signed CapRover certificate (measured)

  grafana-bi:
    kind: grafana
    base_url: https://grafana-v2.prod.bi.uq-systems.net
    auth: bearer
    token: REPLACE
    tls_insecure: true             # self-signed CapRover certificate (measured)

  # ------------------------------------------------------------------ Databases
  # One `db` target lists the PostgreSQL databases `crafty db` may read: a name a
  # statement can address, and the connector string that reaches it - the same
  # string you would give psql, password included, percent-encoded the way a
  # Postgres URI spells one (@ -> %40, $ -> %24). Every connection is opened
  # read-only, and nothing else resolves the credential: it is in the string.
  #
  #   crafty db list
  #   crafty db om query 'select count(*) from orders'
  #   crafty db om query orders 'status = 1'      one table, one WHERE clause
  #   crafty db om tables                 - also: views, triggers, schemas, databases
  #   crafty db all query "select ... from om.public.orders o join sd.public.orders s on ..."
  #
  # `crafty db all <verb>` covers every database at once; a statement over `all`
  # joins across them by naming a table as <database>.<schema>.<table>.
  apps:
    kind: db
    databases:
      agg: postgres://aggregator_gateway_user:REPLACE@192.168.86.141:5432/aggregator_gateway
      dt: postgres://deliverytracker_user:REPLACE@192.168.86.141:5432/deliverytracker
      sd: postgres://smartdispatcher:REPLACE@192.168.86.199:5432/smartdispatcher
      mm: postgres://user_menu_maker_admin:REPLACE@uq-application-database.production.uq-systems.net:5432/menu_maker
      om: postgres://user_sd_order_manager_admin:REPLACE@uq-application-database.production.uq-systems.net:5432/sd_order_manager

  # --------------------------------------------------------- Bitbucket / Jira
  bitbucket:
    kind: bitbucket
    base_url: https://api.bitbucket.org/2.0
    workspace: craftablesoftware
    auth: basic
    username: tiago.soares@craftablesoftware.com
    # An Atlassian API token (email + token over basic), not an app password.
    password: REPLACE

  jira:
    kind: jira
    base_url: https://craftable.atlassian.net
    auth: basic
    username: tiago.soares@craftablesoftware.com
    password: REPLACE
```

## Credentials

There is no store. A credential comes from the environment or from the target written in `config.yml`, resolved in
this order and used as it is:

1. `BITBUCKET_API_TOKEN` / `JIRA_API_TOKEN`, kept so `crafty` stays drop-in beside `bkt`;
2. `OPS_SECRET_<SECRET>` for a target that names a `secret:` key, so CI can inject one without touching the file;
3. **the value written in `config.yml`** (`password:` for basic, `token:` for bearer).

A `db` target is outside that order on purpose: its credential is inside the connector string, used exactly as
written, and `crafty db list` reports per database whether the server accepted it.

`crafty config show` says where each target's credential comes from - `env OPS_SECRET_GRAFANA_BI`, `env JIRA_API_TOKEN`,
`file`, or `none` - and never prints a value. Every credential read is registered for redaction before it can reach a
log line, an error message or a `--dry-run` body.

Provisioning one is either an export or an edit:

```bash
export OPS_SECRET_GRAFANA_BI=...        # CI, or a shell that keeps it
$EDITOR ~/.config/ops-cli/config.yml    # or write `password:` / `token:` in the target
```

A target with no credential fails as `auth` and names both ways to give it one. Nothing is written back to the file
by this CLI.

## Output

Every verb takes the same output flags: `--json` (the envelope), `--format table|csv|plain`, `--no-color`,
`-v/--verbose`, `-c/--config <path>`.

```json
{ "ok": true, "source": "opensearch", "target": "opensearch-staging",
  "data": [], "meta": { "count": 0, "truncated": false, "duration_ms": 12 } }
```

A failure is the same envelope with `"ok": false` and `"error": { "kind", "message", "status", "hint" }`, printed to
**stdout** so one parser reads both cases. Human mode writes `ops <group> <verb>: <message>` plus the hint to stderr.

| Exit code | Meaning |
|---|---|
| 0 | success |
| 1 | runtime failure (`config`, `not-found`, `conflict`, `rate-limit`, `network`, `upstream`, `remote`, `internal`) |
| 2 | usage error - the command line, not the infrastructure |
| 3 | authentication or authorisation failure |

`kind` is one of `usage`, `config`, `auth`, `not-found`, `conflict`, `rate-limit`, `network`, `upstream`, `remote`,
`internal`. Row sets are arrays of flat objects with fixed keys; `meta.truncated` says the client-side cap
(`settings.max_rows`, or the verb's `--limit`) cut the list.

## Safety

- **Read-only by default.** Postgres and ClickHouse SQL is screened by `assertReadOnly`: one statement, a read-only
  leading keyword, and no `insert`/`update`/`delete`/`drop`/`set`/`format`/... anywhere outside string literals and
  comments. The Postgres session is additionally opened `READ ONLY` with a `statement_timeout`. OpenSearch, Kibana,
  Prometheus and Grafana accept `GET` plus the search `POST`s their APIs require.
- **Writes need `--yes`.** Every `bb *`/`jira *` write and every recipe step that calls one refuses to run without
  it, printing the intended action and exit 2 with `hint: re-run with --yes`. `--dry-run` prints the resolved
  request (method, path, body) or command, after redaction, and sends nothing. A recipe passes `--yes` down only to
  the steps whose command declares it.
- **Nothing is retried that could double a write.** Retries are limited to `GET` and the search endpoints, on
  429/502/503/504, twice, honouring `Retry-After`.
- **`ssh` is non-interactive.** `BatchMode=yes` means a missing key fails fast instead of hanging on a prompt.

## DB (read-only SQL over the configured databases)

`crafty db` reads the PostgreSQL databases the config file lists, one statement at a time, and never writes: the guard
refuses anything that is not a single read, and every connection is opened read-only. The database is the subject, so
a verb reads as a sentence:

```bash
crafty db list                                       # every configured database, and whether it answers
crafty db om query 'select count(*) from events'
crafty db om query events 'status = 1'               # select * from events where status = 1
crafty db om describe orders                         # columns, from information_schema
crafty db om tables                                  # also: views, triggers, schemas, databases
crafty db om whoami
crafty db om query --file reports/open-orders.sql
crafty db all tables                                 # every database at once, each row tagged with its source
```

The table shorthand asks one database: `crafty db all query events 'id > 5'` is refused, and points at
`crafty db om query events 'id > 5'`.

`crafty db <database> query` takes either a whole statement in one argument, or a table and a WHERE clause in two:
`crafty db om query events 'status = 1'` sends `select * from events where status = 1`, with the clause used exactly as
written (so `'status = 1 order by id desc'` works). Nothing is inferred - a table on its own, three arguments, or a
first argument that is a query word are each refused with both forms spelled out. `crafty db <database> <verb>` runs the
statement on that database, which is where the work happens, so it is the fast path. `crafty db all <verb>` covers every configured database instead: listings come back as one row set tagged with the
database each row came from, and a statement may join across databases by naming each table
`<database>.<schema>.<table>`:

```bash
crafty db all query "select o.id, s.status
                    from om.public.orders o
                    join sd.public.orders s on s.id = o.id"
```

`all` is only a name: it is refused as a database in the config file, so a database can never shadow it.

A statement sent to one database is executed by that server, so filtering and ordering happen there and come back
fast. A statement over `all` is read row by row, so filter it well: measured on `sd.dispatch_orders` and
`om.events`, the single-database form answered in **0.9 s**, the cross-database join did not finish in **120 s** (a
plain join of the two took ~43 s). When in doubt, ask one database at a time.

Rows are capped client-side at `--limit` (default `settings.max_rows`) and never by rewriting your SQL.
`meta.database` and `meta.databases` say what was reached, and a listing over `all` reports a database that could not
be read in `meta.failed` instead of failing the whole row set. Every connector string is used exactly as written and
is redacted from every error, log line and `--json` body: a statement never reaches a command line, only a pipe.

## SSH

```bash
crafty ssh hosts                                   # the aliases ~/.ssh/config defines
crafty ssh run uq-observability -- hostname
crafty ssh run uq-observability uq-ingress-controller --parallel 2 -- hostname
crafty ssh run --all -- 'uptime'
crafty ssh logs uq-observability --container signoz-signoz --since 30m --lines 50 --grep error
crafty ssh logs uq-observability --unit ssh --since 2h
crafty ssh logs uq-observability --file /var/log/syslog --lines 100
crafty ssh logs uq-observability --container signoz-signoz --follow   # streams, Ctrl-C stops it
crafty ssh ps uq-observability --all
crafty ssh df uq-observability
crafty ssh health uq-observability
```

`run` passes everything after `--` as separate arguments, so quoting survives both hops; use
`sh -c '...'` when the remote side needs pipes. `logs --grep` filters locally and case-insensitively;
`--follow` needs the terminal, so it refuses `--json`, `--grep` and `--file`.

`docker logs` writes the container's stdout and stderr to two different pipes, so the rows are merged and re-ordered
by their Docker timestamps. Container rows are `{ host, container, ts, message, raw }`, journald rows carry `unit`
instead of `container`, file rows carry `file` and no `ts`, `ps` rows are `{ host, name, image, status }`, `df` rows
`{ host, filesystem, size, used, avail, use_percent, mount }`, and `health` is one row
`{ host, uptime, load: { "1m", "5m", "15m" }, mem_total_mb, mem_used_mb, disks: [...] }`.

## Recipes

A recipe is a markdown file: YAML front matter the CLI runs, prose a human reads. They are found in
`--recipes-dir` (repeatable, first wins), then `$OPS_RECIPES_DIR`, then `~/.config/ops-cli/recipes`, then the ones
shipped here. A name defined twice **in one directory** is an error; across directories the first wins.

```markdown
---
name: host-health
description: Hostname, load and disk for one VM
params:
  host:
    default: uq-observability
    description: SSH alias from ~/.ssh/config
steps:
  - id: identity
    run: ssh run {{params.host}} -- hostname
  - id: load
    run: ssh health {{params.host}} --json
    quiet: true                    # do not echo this step's output
  - id: probe
    run: ssh logs {{params.host}} --container signoz-signoz --lines 5
    continue_on_error: true        # a failure is recorded, not fatal
---
# Anything after the second --- is prose; the engine never interprets it.
```

```bash
crafty recipe list
crafty recipe show host-health
crafty recipe run host-health --param host=uq-ingress-controller
crafty recipe run host-health --json          # every step's argv, exit code, duration and stdout
crafty recipe run host-health --dry-run       # the resolved commands, nothing runs
```

`run` is a string (tokenised like a shell line) or a list of arguments; a leading `crafty` or `ops` is stripped. A step is
dispatched in-process exactly as if you had typed it, so it is the same code path, the same flags and the same
errors. Substitutions:

| Placeholder | Value |
|---|---|
| `{{params.x}}` | the parameter, default or `--param x=...`; a param with no default is required |
| `{{steps.id.stdout}}` | the step's captured stdout, trailing whitespace removed |
| `{{steps.id.json}}` | the step's stdout parsed as JSON (give the step `--json`), re-serialised |
| `{{steps.id.json.a.b.0}}` | a dotted path into that JSON, numeric indices included |
| `{{steps.id.exit_code}}` | the step's exit code |
| `\{{` | a literal `{{` |

Substitution happens per argument after tokenisation, so a parameter containing spaces stays one argument. A step
whose failure is not marked `continue_on_error` stops the run and becomes the exit code; `continue_on_error` records
the failure in the envelope (and `meta.tolerated`) without failing the run.

## Sources

### Postgres, through `crafty db`

```bash
crafty db om query 'select current_user, current_database()'
crafty db om query events 'status = 1'
crafty db om query "select event_name, count(*) from events where created_at >= current_timestamp - interval '24 hours' group by 1"
crafty db sd query "select table_name from information_schema.tables where table_name like 'dispatch%'"
crafty db om describe orders
crafty db om whoami
crafty db list
```

The database names itself, the statement is Postgres SQL executed by that server, so anything the server can do, it
does. When the credential is wrong the server says so, and `crafty db list` reports it per database. Rows are capped
client-side at `--limit` (default `settings.max_rows`) and never by rewriting your SQL.

| Name | Database | Where |
|---|---|---|
| `agg` | `aggregator_gateway` | self-hosted `192.168.86.141` |
| `dt` | `deliverytracker` | self-hosted `192.168.86.141` |
| `sd` | `smartdispatcher` | self-hosted `192.168.86.199` |
| `mm` | `menu_maker` | AWS Aurora (RDS) |
| `om` | `sd_order_manager` | AWS Aurora (RDS), same instance as `mm` |

### OpenSearch and Kibana

The catalog in the file is what keeps these short: `--level` and `--text` use the field names the target publishes
(`level_field`, `text_fields`), so a KQL string never gets handed to `query_string` - the documented
`log_level:ERROR and service:smartdispatcher` returns **28.8 M** hits (lowercase `and` is a term), while
`--level ERROR --query 'service:smartdispatcher'` returns the **29 283** that actually match. `--level` uses the
target's `level_field`; when one cluster holds families that disagree (`uq-production-*` has `level`, the logback
mirror has `log_level`), name it for that query: `--level ERROR --level-field log_level`.

```bash
crafty os health --target os-prod
crafty os indices --pattern 'uq-production-*'
crafty os query --target os-prod --level ERROR --text dispatchDe --since 6h
crafty os health --target opensearch-staging
crafty os indices --pattern 'filebeat-*'
crafty os mapping filebeat-2026.10.07
crafty os count --index 'filebeat-*' --query 'level:ERROR'
crafty os query --index 'filebeat-*' --since 1h --query 'level:ERROR AND service:api' --fields '@timestamp,message' --size 20
crafty os query --index 'filebeat-*' --dsl-file /tmp/query.json --all
crafty kibana status
crafty kibana spaces
crafty kibana saved --type dashboard --search 'payments'
crafty kibana query --index 'filebeat-*' --query 'level:ERROR' --since 30m
```

Rows are `{ _index, _id, ts, ...selectedFields, _source }` with `ts` taken from the target's `time_field`. `--all`
pages with the scroll API, because OpenSearch 2.5 has no point-in-time for `search_after`. Every non-`GET` Kibana
call carries `kbn-xsrf`, as the API requires.

### SigNoz (ClickHouse over ssh)

```bash
crafty signoz databases
crafty signoz tables --database signoz_logs
crafty signoz describe logs_v2
crafty signoz query --sql 'select count() from signoz_logs.logs_v2'
crafty signoz logs --since 1h --limit 200 --severity ERROR,WARN --grep timeout
```

SQL is piped into `docker exec -i ... clickhouse-client --format JSON` over ssh - never passed as `--query`, because
shell quoting mangles `resources_string['host.name']`. Rows are the rows ClickHouse returned; the log builder reads
`signoz_logs.logs_v2` with its nanosecond `timestamp`.

### Prometheus and Grafana

```bash
crafty prom query 'rate(http_requests_total[5m])' --at 2026-10-07T12:00:00Z
crafty prom range 'node_load1' --since 6h --step 60s
crafty prom labels
crafty prom label instance
crafty prom series --match 'up{job="api"}'
crafty prom targets
crafty prom alerts
crafty grafana health
crafty grafana datasources
crafty grafana dashboards --query payments
crafty grafana dashboard <uid>
crafty grafana annotations --from 'now-6h' --to now
crafty grafana query --datasource Prometheus --expr 'rate(http_requests_total[5m])' --since 1h --step 30s
```

A non-`success` Prometheus status is an `upstream` failure naming its `errorType`. `grafana query` resolves
`--datasource` by name through `/api/datasources` first, and flattens frames to
`{ series: [{ metric, points: [[ts, value]] }] }`.

### Bitbucket

```bash
crafty bb repo list --query payments --all
crafty bb repo view craftablesoftware/payments-api
crafty bb repo clone craftablesoftware/payments-api
crafty bb pipeline list craftablesoftware/payments-api --limit 10
crafty bb pipeline logs <uuid> --step <step-uuid>
crafty bb pr list craftablesoftware/payments-api --state OPEN
crafty bb pr view 42 --comments
crafty bb pr diff 42 --stat
crafty bb pr create --title 'fix: retry' --source feat/retry --reviewer <uuid> --yes
crafty bb pr comment 42 --text 'looks good' --yes
crafty bb pr merge 42 --strategy squash --yes
```

`bb status`, `bb commit` and `bb push` work on the clone under `settings.data_dir/repos/<workspace>/<repo>` and never
`--force`. `bb commit` uses `--author`, else `settings.git_author`, else git's own configuration. `bb pipeline run`
accepts `--branch`, or `--custom <pattern>` with repeated `--var K=V`.

### Jira

```bash
crafty jira me
crafty jira boards --project UQ
crafty jira sprints --board 12 --state active
crafty jira issues --assignee me --status 'In Progress' --limit 20
crafty jira issues --jql 'project = UQ AND labels = incident' --all
crafty jira count --jql 'project = UQ AND status != Done'
crafty jira issue UQ-123 --comments 5
crafty jira comment UQ-123 --body 'Deployed to staging' --yes
crafty jira assign UQ-123 me --yes
crafty jira labels UQ-123 --add incident --remove triaged --yes
crafty jira transitions UQ-123
crafty jira transition UQ-123 'In Review' --comment 'PR up' --yes
crafty jira create --project UQ --type Task --summary 'Rotate the token' --labels ops --yes
```

Jira Cloud REST v3: issue search is `POST /rest/api/3/search/jql`, paged on `nextPageToken` until `isLast`. Text
becomes Atlassian Document Format on the way out and back, so `--body`/`--description` take plain text.
`jira labels` reads the issue first and rewrites the whole field, because Jira replaces it.

## Doctor

```bash
crafty doctor                                    # one probe per configured target, exit 1 if any fails
crafty doctor --target pg-staging --app lastmile --json
```

A probe is the cheapest call that proves the source is reachable **and** authorised: `ssh run <host> -- true`,
`GET /_cluster/health`, `GET /api/status`, `GET /api/v1/status/buildinfo`, `GET /api/health`, `SHOW DATABASES` over
ssh, a Postgres connect plus `select 1`, `GET /2.0/user`, `GET /rest/api/3/myself`. Each row is
`{ target, kind, status: ok|auth|unreachable|error, detail, duration_ms }`. `--app` fills `{app}` for a Postgres
target that resolves its DSN per service.

## Known limits

- `development-kibana.iag-bsa.com` is only reachable over the VPN; the AWS OpenSearch domains answer HTTP 401 with
  `WWW-Authenticate: Basic realm="OpenSearch Security"` until an FGAC credential is stored.
- The AWS domains serve OpenSearch Dashboards, which is **not** the Kibana API; use `crafty os` for them.
- The BI Prometheus/Grafana vhosts still serve the CapRover default page, behind a CapRover self-signed
  certificate (`CN = caprover.com`). Both carry `tls_insecure: true`, so a probe now gets past TLS and reports the
  HTTP answer (`error`, the CapRover page) instead of a TLS failure - the app is not deployed there yet.
- Every configured database answers (`agg`, `dt`, `sd`, `mm`, `om`) as of 2026-10-08, `dt` included after its
  password was replaced: `crafty db list` reports it per database, and `crafty doctor --target apps` says
  `5 database(s) answered select 1`. One statement can join across them (`crafty db all query ...`).
- Bitbucket and Jira need a token: write it in the target (`password:`), or export `BITBUCKET_API_TOKEN` /
  `JIRA_API_TOKEN`. The `jira` target resolves from the environment today; the Bitbucket one carries a value in the
  file, and their live behaviour was verified against the real APIs and mock servers.
- Recipes and integration configuration belong to this client, not the framework package.
  `--recipes-dir` / `$OPS_RECIPES_DIR` add the operator's own recipes; existing ops-prefixed recipe inputs still work.

## Verification

Verified on Linux x64 with Bun 1.4.2 after the framework/client extraction:

- This client's `bun run test`: 367 passing tests across 21 files; `bun run typecheck`: clean.
- The framework's separate suite: 24 passing tests; its typecheck: clean.
- The linked client ran from `/tmp` and used its locally installed Crafty 0.2.0 dependency while
  reporting its own application version 0.1.0.
- `recipe list --json` found `client/recipes/host-health.md` outside the repository's working directory.
- `config init` wrote the exact client-owned template to a temporary file with mode 0600.
- DB and Bitbucket help worked without loading infrastructure credentials.
- An isolated client installed the packed framework and discovered added, edited, and removed command
  modules on subsequent invocations without rebuilding or relinking.

Linking and config-write smoke checks used temporary locations. Live infrastructure APIs were not
re-probed during this extraction; the service observations above predate it.

Completion was additionally verified with framework 0.3.0: 39 framework tests and 367 client tests passed, both typechecks passed, and actual Bash/Zsh Tab interactions covered aliases, routes, flags, enum values, paths with spaces, and live command changes. All shell links and fixtures used isolated temporary locations.
