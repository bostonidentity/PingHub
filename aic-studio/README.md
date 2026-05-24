# AIC Studio for Ping Advanced Identity Cloud

Manage Ping AIC tenant configurations from inside VS Code — pull, edit, diff, push, promote, and monitor environments without leaving your editor.

Part of [PingHub](https://github.com/bostonidentity/PingHub) — open-source tooling from [Boston Identity](https://bostonidentity.com).

## Features

- **Environments sidebar:** per-env tree showing realms, journeys, federation (SAML2 + OAuth2) configs
- **Pull from AIC:** OAuth client_credentials, fetches all journeys + federation, stored as flat JSON snapshots on disk
- **Push single journey:** right-click → "Push to environment…" with modal confirmation
- **Promotion tasks:** group items to push as a batch with continue-on-failure summary
- **Compare:** built-in diff editor between two envs, or between two snapshots of the same env
- **Find usage:** cross-reference search showing where a script/SAML provider/OIDC client is referenced
- **Source Control panel:** locally-modified items show up as VS Code SCM "Changes"
- **Operation history:** every pull/push/promote logged with timestamps + statuses; daily grouped view in the sidebar
- **Monitors:** background polling of TLS expiry + server ping per env; alerts with severity bands
- **Logs:** query AIC `monitoring/logs` API (am-everything, am-authentication, idm-everything, etc.); save queries per env
- **Federation editor:** view SAML2 / OAuth2Client configs in a webview (editor is read-only in v1; save in v1.1)
- **Dashboard:** summary view auto-opens on activation showing env health + recent ops + alerts
- **Search:** Cmd+Shift+P → "AIC Studio: Search configs…" — fast QuickPick across all envs/journeys/federation/tasks
- **Credentials in keychain:** AIC service-account password + client secret + log API key/secret all in VS Code SecretStorage (OS keychain)

## Getting Started

1. Install the extension from the VS Code Marketplace (search for "AIC Studio for Ping Advanced Identity Cloud").
2. Click the PingHub icon in the activity bar.
3. Run **AIC Studio: Add environment…** from the command palette (Cmd/Ctrl+Shift+P). Enter your tenant URL, service-account username, OAuth client ID, and the corresponding secrets.
4. Run **AIC Studio: Pull from environment** — journeys and federation configs appear in the sidebar tree under your env.
5. Click a journey to view it in the editor (read-only). Right-click to compare with another env, push to another env, or add to a promotion task.

For the in-VS-Code walkthrough, run **Welcome: Open Walkthrough** → **Getting Started with AIC Studio**.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `aic-studio.activeEnvironment` | "" | The currently active env (set via the status bar) |
| `aic-studio.autoOpenDashboard` | `true` | Open the dashboard webview on activation |
| `aic-studio.monitor.tlsThresholdDays` | `30` | Days remaining before TLS is flagged as warning (below 14 = error) |
| `aic-studio.monitor.pollIntervalMinutes` | `15` | How often background monitors run |

## Commands

All commands are under the `AIC Studio:` category in the command palette.

Major commands:
- `AIC Studio: Add environment…`
- `AIC Studio: Pull from environment`
- `AIC Studio: Push to environment…`
- `AIC Studio: Compare with environment…`
- `AIC Studio: Compare with revision…`
- `AIC Studio: Add to promotion task…`
- `AIC Studio: Run promotion task…`
- `AIC Studio: Open federation editor`
- `AIC Studio: Open log query editor…`
- `AIC Studio: Open dashboard`
- `AIC Studio: Open monitor dashboard`
- `AIC Studio: Search configs…`
- `AIC Studio: Find usage`

## Privacy & Security

- Credentials are stored in VS Code `SecretStorage` (backed by the OS keychain on macOS/Windows/Linux).
- All snapshot data is stored locally under VS Code's `globalStorage` directory (`pinghub.db` SQLite file + flat JSON snapshot directories).
- No telemetry is sent to Boston Identity or PingHub.
- All AIC operations are logged to the "AIC Studio" OutputChannel for transparency.

## Development

```
cd aic-studio
npm install
npm run build
```

Then press F5 in VS Code at the repo root to launch the Extension Development Host. See [`docs/superpowers/specs/`](../docs/superpowers/specs/) and [`docs/superpowers/plans/`](../docs/superpowers/plans/) for the design and implementation specs.

## Status

Pre-release. v1.0.0 in preparation. The federation editor save flow is deferred to v1.1; everything else listed above is in v1.0.

## Support

- Issues: https://github.com/bostonidentity/PingHub/issues
- Discussions: https://github.com/bostonidentity/PingHub/discussions

## License

[Apache 2.0](./LICENSE)
