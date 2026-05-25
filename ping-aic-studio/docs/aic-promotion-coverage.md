# AIC Native Promotion vs. Pipeline Coverage

Ping Advanced Identity Cloud (AIC) has a built-in promotion feature in the tenant console that detects all configuration differences between a lower and upper environment and promotes them as a unit. This document compares what the native AIC promotion covers against what this pipeline tool pulls and promotes.

## How AIC Native Promotion Works

The native promotion uses the `/environment/promotion/*` REST API. It compares the full configuration state between two linked environments and produces a diff report. When run, it promotes **all detected changes at once** — there is no item-level selection. The `fr-config-promote` CLI is a thin wrapper around this API.

This pipeline tool augments the native promotion with:
- Item-level selection (promote individual journeys, scripts, etc.)
- Dependency resolution (journeys automatically include referenced scripts and sub-journeys)
- ID remapping (handles cases where the same logical item has different UUIDs across environments)
- ESV value pull (native promotion never exposes actual variable values)

---

## Coverage Comparison

| Configuration Area | AIC Native Promotion | This Pipeline | Tool |
|---|:---:|:---:|---|
| **Journeys & Auth** | | | |
| Journeys / auth trees | ✅ | ✅ | fr-config-manager |
| Scripts | ✅ | ✅ | fr-config-manager |
| Custom endpoints | ✅ | ✅ | fr-config-manager |
| Authentication config | ✅ | ✅ | fr-config-manager |
| Custom nodes | ✅ | ✅ | fr-config-manager |
| AM services | ✅ | ✅ | fr-config-manager |
| KBA config | ✅ | ✅ | fr-config-manager |
| Password policy | ✅ | ✅ | fr-config-manager |
| Authorization policies | ✅ | ✅ | fr-config-manager |
| Access config | ✅ | ✅ | fr-config-manager |
| Terms & conditions | ✅ | ✅ | fr-config-manager |
| **Identity & Connectors** | | | |
| Managed objects | ✅ | ✅ | fr-config-manager |
| Connector definitions | ✅ | ✅ | fr-config-manager |
| Connector mappings | ✅ | ✅ | fr-config-manager |
| Remote connector servers | ✅ | ✅ | fr-config-manager |
| IDM authentication | ✅ | ✅ | fr-config-manager |
| Service objects | ✅ | ✅ | fr-config-manager |
| Internal roles | ✅ | ✅ | fr-config-manager |
| Org privileges | ✅ | ✅ | fr-config-manager |
| **Federation** | | | |
| OAuth2 agents / clients | ✅ | ✅ | fr-config-manager |
| SAML entities | ✅ | ✅ | fr-config-manager |
| AM policy agents | ✅ | ✅ | frodo |
| Social / OIDC providers | ✅ | ✅ | frodo |
| **Secrets & Variables** | | | |
| Secret labels (metadata) | ✅ | ✅ | fr-config-manager |
| Secret mappings | ✅ | ✅ | fr-config-manager |
| ESV variable definitions | ✅ | ✅ | frodo |
| **ESV variable values** | ❌ never exposed | ✅ | frodo |
| **UI & Comms** | | | |
| Themes | ✅ | ✅ | fr-config-manager |
| UI config | ✅ | ✅ | fr-config-manager |
| Email templates | ✅ | ✅ | fr-config-manager |
| Email provider | ✅ | ✅ | fr-config-manager |
| Locales | ✅ | ✅ | fr-config-manager |
| **Infrastructure** | | | |
| Schedules | ✅ | ✅ | fr-config-manager |
| CORS | ✅ | ✅ | fr-config-manager |
| CSP | ✅ | ✅ | fr-config-manager |
| Cookie domains | ✅ | ✅ | fr-config-manager |
| Audit config | ✅ | ✅ | fr-config-manager |
| Telemetry | ✅ | ✅ | fr-config-manager |
| **IGA** | | | |
| IGA workflows | ✅ probably | ✅ | fr-config-manager |
| IGA forms | ❓ unclear | ✅ | iga-api |
| IGA notifications | ❓ unclear | ✅ | iga-api |
| IGA assignments | ❓ unclear | ✅ | iga-api |
| **Not promotable** | | | |
| Custom domains | ❌ env-specific infra | ❌ n/a | — |
| Certificates | ❌ env-specific infra | ❌ n/a | — |

---

## Known Gaps / Open Questions

### `frodo app` vs. `oauth2-agents`
Frodo distinguishes between `oauth2-agents` (OAuth2 client registrations managed at the agent layer) and `app` (AM application objects). These may not be fully equivalent. If "Applications" appear in the AIC console as a distinct category from OAuth2 agents, items created there may not be fully captured by the `oauth2-agents` scope. **This warrants investigation.**

### IGA in native promotion
The native AIC promotion is AM/IDM-focused. IGA (Identity Governance) has its own API tier and it is unclear whether IGA forms, notifications, and assignments are included in the standard `/environment/promotion` flow. This pipeline covers them via the IGA REST API regardless.

### ESV values
The AIC promotion API deliberately never exposes actual ESV variable values (security boundary). This pipeline pulls values via `frodo esv variable export`, which decodes and stores them alongside the variable metadata. These are not promoted between environments — values are environment-specific and must be set independently.

---

## Summary

The pipeline covers everything the native AIC promotion covers, and goes further in several areas (IGA, ESV values, item-level selection). The one area to verify is whether `frodo app` captures application objects that fall outside the `oauth2-agents` scope.
