# PingHub

Open-source tooling for working with [Ping Advanced Identity Cloud](https://www.pingidentity.com/en/platform/capabilities/advanced-identity-cloud.html) (AIC), maintained by [Boston Identity](https://bostonidentity.com).

PingHub is a monorepo. Each top-level directory is an independent project with its own README, dependencies, and release cadence.

## Quick start

### macOS / Linux

```bash
git clone https://github.com/bostonidentity/PingHub.git
cd PingHub
./start
```

To stop:

```bash
./stop
```

### Windows (Command Prompt)

```cmd
git clone https://github.com/bostonidentity/PingHub.git
cd PingHub
start.cmd
```

To stop:

```cmd
stop.cmd
```

`./start` detects your OS, ensures Node 20+ (uses system Node if present, otherwise auto-downloads Node 20.18.0 into `aic-pipeline/.pinghub-node/`), installs dependencies, builds, and launches the web UI in the background. Your browser opens to `http://127.0.0.1:3000` (or another free port if 3000 is taken — the chosen URL is shown in the start output and in the log).

**First run** takes ~30-60 seconds (npm install + build). Subsequent launches start in seconds.

**Server runs detached** — closing the browser does NOT stop it. Use `./stop` (or `stop.cmd`) to shut down.

**Logs** are at `aic-pipeline/.pinghub-logs/pinghub.log`. Follow live with:

```bash
tail -f aic-pipeline/.pinghub-logs/pinghub.log
```

**Updates:** `./start` checks for upstream commits each launch and prints `⚡ N update(s) available` if any. To pull and restart:

```bash
./stop
git pull
./start
```

See [aic-pipeline/README.md](./aic-pipeline/README.md) for full flag reference (`--port`, `--no-open`, `--reinstall`, `--bundled-node`, etc.) and Node-version-handling details.

## Projects

| Project | Description |
|---|---|
| [`aic-pipeline/`](./aic-pipeline) | Web UI for AIC tenant config management — pull, push, and promote configs across environments with a guided diff-review workflow. |

More projects will be added to this monorepo over time.

## Repository layout

```
PingHub/
  aic-pipeline/          # AIC config pipeline UI (Next.js)
  start, stop            # mac/linux launcher
  start.cmd, stop.cmd    # Windows launcher
  docs/                  # design specs, plans, session logs
  LICENSE                # Apache 2.0 — applies to every project in this repo
  NOTICE                 # Third-party attribution (applies to the whole repo)
  SECURITY.md            # How to report vulnerabilities privately
  CODE_OF_CONDUCT.md     # Community conduct standards
```

## License

Every project in this repository is licensed under the [Apache License, Version 2.0](./LICENSE). See [NOTICE](./NOTICE) for third-party attribution.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).

## Community

- Issues: https://github.com/bostonidentity/PingHub/issues
- Discussions: https://github.com/bostonidentity/PingHub/discussions

By participating in this project you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
