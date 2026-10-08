---
name: host-health
description: Hostname, load and disk for one VM
params:
  host:
    default: uq-observability
    description: SSH alias from ~/.ssh/config
  since:
    default: 1h
steps:
  - id: identity
    run: ssh run {{params.host}} -- hostname
  - id: load
    run: ssh health {{params.host}} --json
  - id: disk
    run: ssh df {{params.host}} --json
---
# Host health

Read-only. Swap `host` for any alias `crafty ssh hosts` prints.

```
crafty recipe run host-health --param host=uq-ingress-controller
```

The steps are the commands you would otherwise type by hand, run in order and
stopped at the first failure. `--json` gives every step's exit code and its
captured stdout, which is what an agent driving this CLI wants:

```
crafty recipe run host-health --json
```
