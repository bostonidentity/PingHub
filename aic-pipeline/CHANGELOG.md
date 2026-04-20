# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-20

First public release of PingHub under the Apache License 2.0.

### Added

- Web UI for Ping Advanced Identity Cloud config management.
- **Pull**: streaming-log pull for 40+ config scopes (journeys, scripts, IDM managed objects, endpoints, IGA applications/entitlements, SAML, CSP, themes, and more).
- **Push**: push local config back to a tenant, with production-only confirmation.
- **Promote**: multi-phase promotion workflow — lock, dry-run diff, review, promote, verify, unlock, rollback.
- **Journey viewer**: interactive ReactFlow graph plus outline, table, swim-lane, and JSON views. Inline node details, script overlay, search, trace upstream/downstream/data paths, fold passthrough chains, ELK or dagre layouts.
- **Semantic journey diff**: compare journeys across environments with a canvas that highlights added / removed / modified / unchanged nodes, side-by-side script diffs, and inner-tree navigation.
- **Environments manager**: guided tenant-add wizard, raw `.env` editor, tenant connection test.
- **Search / analyze**: global search across scopes; find-usage for scripts, endpoints, and inner journeys.
- Vendored subset of [`fr-config-manager`](https://github.com/ForgeRock/fr-config-manager) under `src/vendor/` (MIT licensed — see `NOTICE`).
- Apache 2.0 license, project metadata, `SECURITY.md`, `CODE_OF_CONDUCT.md`.

[Unreleased]: https://github.com/bostonidentity/PingHub/compare/aic-pipeline/v0.1.0...HEAD
[0.1.0]: https://github.com/bostonidentity/PingHub/releases/tag/aic-pipeline/v0.1.0
