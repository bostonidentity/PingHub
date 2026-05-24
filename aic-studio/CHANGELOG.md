# Changelog

All notable changes to AIC Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (M1 — scaffold & environments)

- Project scaffold: TypeScript, esbuild, vitest, @vscode/test-electron, ESLint
- PingHub activity bar icon
- Five sidebar TreeViews (Environments + 4 placeholders)
- SQLite-backed environment storage at `globalStorageUri/pinghub.db`
- `SecretStorage`-backed credentials (password, client secret, log API key/secret)
- Commands: `aic-studio.env.add`, `aic-studio.env.setActive`, `aic-studio.env.remove`
- Status bar item showing active environment
- CI workflow on 4 OS targets
- Insiders publish workflow (drafted, awaiting secrets)
