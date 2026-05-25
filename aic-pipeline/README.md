# aic-pipeline

A web UI for managing Ping Advanced Identity Cloud (AIC) tenant configurations — pull config from a tenant, push it back, and promote it across environments (dev → staging → prod) with a guided diff-review workflow.

This project is part of [PingHub](https://github.com/bostonidentity/PingHub) — see the monorepo root for license and contribution information.

Built on top of a vendored subset of [`fr-config-manager`](https://github.com/ForgeRock/fr-config-manager) so teams can drive the pull/push/promote lifecycle from a browser instead of the CLI.

## Features

- **Pull** — stream live CLI output while fetching config for any scope (journeys, scripts, IDM managed objects, endpoints, IGA applications/entitlements, SAML, CSP, themes, and more — 40+ scopes).
- **Push** — apply local config back to a tenant, with a production-only confirmation step.
- **Promote** — multi-phase workflow: lock → dry-run diff → review → promote → verify → unlock, with rollback. Controlled environments use an in-process Direct Configuration Change (DCC) session: open → dry-run → push (with `X-Configuration-Type: mutable`) → apply → pull-target → verify, with each phase surfaced as its own log section.
- **Journey viewer** — browse journeys as an interactive ReactFlow graph, outline, table, swim-lane, or raw JSON. Inline node details, script overlay, search, trace upstream/downstream/data paths, fold passthrough chains, ELK or dagre layouts.
- **Semantic journey diff** — compare journeys across environments with a canvas that highlights added / removed / modified / unchanged nodes, side-by-side script diffs, and inner-tree navigation.
- **Data** — browse managed-object snapshots and run on-demand data pulls from the UI. Per-type record tables, detail pane, JSON export, shared env pill, last-pulled age, ETA, idle banner, and a global banner that surfaces in-flight background jobs across navigation.
- **Environments manager** — add tenants through a guided wizard; raw `.env` editor, tenant connection test, and in-process tenant restart.
- **Analyze** — ESV orphan references: find `&{esv}` placeholders and `systemEnv.` lookups that aren't defined under `esvs/`.
- **Search** — global search across scopes, "find usage" for scripts, endpoints, and inner journeys.

## Requirements

- Node.js 20+ (project uses Next.js 16 / React 19).
- npm (lock file is `package-lock.json`).
- Access to one or more Ping AIC tenants and a service account with the scopes you want to manage.
- A local working directory for each tenant's config files (the `CONFIG_DIR` referenced below).

## Install (end users)

Clone the [PingHub monorepo](https://github.com/bostonidentity/PingHub) and run the bootstrap script — it detects your OS, ensures Node 20+, installs dependencies, builds, and launches the web UI.

### macOS / Linux

```bash
git clone https://github.com/bostonidentity/PingHub.git
cd PingHub
./pinghub
```

### Windows (Command Prompt or PowerShell)

```cmd
git clone https://github.com/bostonidentity/PingHub.git
cd PingHub
pinghub.cmd
```

That's it. Your browser opens at `http://127.0.0.1:47391`. `Ctrl-C` to stop.

**On first run** the script will install dependencies and run a production build (~30s on a fast machine). Subsequent launches start in seconds.

### Updating

The script checks the repo for upstream updates each launch. When new commits are available it prints `⚡ N update(s) available` and prompts before continuing. To pull:

```bash
git pull
./pinghub
```

### Flags

Pinghub-script flags:

| Flag | Effect |
|---|---|
| `--reinstall` | Wipe `node_modules` and `.next` before bootstrapping |
| `--bundled-node` | Force download Node 20.18.0 to `./aic-pipeline/.pinghub-node/`, even if system Node is fine |
| `--skip-update` | Skip the `git fetch` update check |

Launcher flags (forwarded to the running app):

| Flag | Effect |
|---|---|
| `--port N` | Override the port (default 47391; falls back to a free port if taken) |
| `--no-open` | Start the server but don't open the browser |
| `--data-dir PATH` | Override `PINGHUB_DATA_DIR` |
| `--version` | Print version and exit |

### Node version handling

The script picks Node in this order:

1. `./aic-pipeline/.pinghub-node/bin/node` (or `node.exe` on Windows) if present — use that
2. System `node` from PATH if version ≥ 20
3. Otherwise, download Node 20.18.0 to `./aic-pipeline/.pinghub-node/` and use it

If you previously ran with `--bundled-node` and later install system Node 20+, delete `./aic-pipeline/.pinghub-node/` to switch back to the system version.

### Pin a specific version

```bash
PINGHUB_VERSION=v0.3.0 curl -fsSL https://raw.githubusercontent.com/bostonidentity/PingHub/main/aic-pipeline/launcher/install.sh | bash
```

## Install (developers)

```bash
git clone https://github.com/bostonidentity/PingHub.git
cd PingHub/aic-pipeline
npm install
```

## Configure tenants

Each tenant is described by:

1. An entry in `environments/environments.json`:
   ```json
   [
     {
       "name": "dev",
       "label": "Development",
       "color": "#22c55e",
       "envFile": "dev.env"
     }
   ]
   ```
2. A matching `.env` file in `environments/` (gitignored by default). Minimum fields:
   ```
   TENANT_BASE_URL=https://openam-<tenant>.forgeblocks.com
   SERVICE_ACCOUNT_ID=<uuid>
   SERVICE_ACCOUNT_KEY={"kty":"RSA",...}   # JWK, single line
   CONFIG_DIR=/absolute/path/to/tenant-config
   REALMS=alpha
   SCRIPT_PREFIXES=MyPrefix_
   ```
   Optional fields cover agents, SAML, policies, managed objects, raw endpoints, CSP, and more — see `src/lib/env-parser.ts` for the full list.

The environments wizard in the UI will create/edit these files for you — the above is mainly useful if you're bootstrapping from the command line.

> `.env*` and `environments/` are gitignored. Keep service-account keys out of any public fork.

### Export, import, and backups

The Environments tab toolbar exposes **Export…**, **Import…**, and **Backups** for migrating tenant configurations between machines without manually copying folders.

- **Export** writes a single `pinghub-envs-<host>-<ts>.json` bundle (schema `pinghub-environments/v1`) containing the chosen envs' metadata, `.env`, `log-api.json`, `rcs-status.json`, and `release.json`. Three secret-handling modes:
  - **Redact** (default) — `SERVICE_ACCOUNT_KEY`, `RCS_PRIVATE_KEY`, `*_TOKEN`, `*_PASSWORD` and similar are replaced with `<REDACTED>`. Safe to share.
  - **Plaintext** — bundle contains real secret values. Treat as sensitive.
  - **Encrypted** — secrets are AES-256-GCM-encrypted with a passphrase (PBKDF2-SHA256, 200 000 iterations). The same passphrase is required at import. **There is no recovery if the passphrase is lost.**
- **Import** lets you choose Skip / Replace / Rename per env. Replacing always creates an automatic backup first. When importing a redacted bundle over an existing env, **Keep live secrets where bundle is redacted** (default ON) preserves the local credentials.
- **Backups** are written to `environments/.backups/<env>-<YYYYMMDD-HHMMSS>.json` (gitignored). The Backups dialog can download, delete, or **Prune old** snapshots — pruning keeps the 10 newest per env and discards anything older than 7 days.

## Run

```bash
npm run dev        # development at http://localhost:3000
npm run build      # production build
npm run start      # production server
```

## Tests

```bash
npm test           # one-shot (vitest)
npm run test:watch # watch mode
```

## Project layout

```
src/
  app/
    api/           # Next.js API routes (pull, push, promote, compare, data, ...)
    configs/       # Browse / viewer (journeys, scripts, endpoints, ...)
    compare/       # Journey + workflow diff canvas
    promote/       # Promotion workflow UI (incl. Direct-Control sessions)
    environments/  # Environment manager + wizard
    data/          # Managed-object snapshot browser + on-demand pull
    analyze/       # ESV orphan references
  components/      # Shared UI (legend modal, log viewer, diff graph, global job banner, ...)
  hooks/           # useDataEnv, useDataPullJobs, useSnapshotRecords, useStreamingLogs
  lib/             # CLI spawning, env parsing, diff, semantic compare, tenant-control, data snapshot-fs
  vendor/
    fr-config-manager/  # Vendored MIT-licensed upstream — see LICENSE inside
```

## Contributing

Pull requests are welcome. Please:

- Open an issue first for anything larger than a small fix.
- Keep PRs focused — one logical change per PR.
- Run `npm run lint` and `npm test` before submitting.
- By submitting a contribution you agree it is licensed under Apache 2.0 (see LICENSE).

## License

Licensed under the Apache License, Version 2.0. See the monorepo [LICENSE](../LICENSE) for the full text and [NOTICE](../NOTICE) for attribution.

The vendored `src/vendor/fr-config-manager/` directory is MIT-licensed (Copyright (c) 2019 – 2024 ForgeRock); its original license is preserved in that directory.
