# Vendored: @forgerock/fr-config-manager

**Upstream:** https://github.com/ForgeRock/fr-config-manager
**Vendored version:** 1.5.12
**Vendored on:** 2026-04-17 (initial), 2026-04-18 (phases 6b–8 batch)

## Vendored files

### Common
- `common/restClient.js` — subset of `packages/fr-config-common/src/restClient.js` (restGet, restPut, restUpsert, restPost, restDelete)
- `common/config-process.js` — subset of `packages/fr-config-push/src/helpers/config-process.js` (replaceEnvSpecificValues, removeProperty, clearOperationalAttributes)

### Pull
- `pull/managed.js`
- `pull/scripts.js`
- `pull/journeys.js`
- `pull/idm-flat-config.js` (generic — covers access-config, audit, idm-authentication, kba, ui-config)
- `pull/password-policy.js` (upstream: `fieldPolicy.js`)
- `pull/org-privileges.js`
- `pull/cookie-domains.js`
- `pull/cors.js`
- `pull/csp.js`
- `pull/locales.js`
- `pull/endpoints.js`
- `pull/internal-roles.js`
- `pull/email-templates.js`
- `pull/custom-nodes.js`
- `pull/themes.js`
- `pull/email-provider.js`
- `pull/schedules.js`
- `pull/iga-workflows.js`
- `pull/terms-and-conditions.js`
- `pull/service-objects.js`
- `pull/raw.js`
- `pull/authz-policies.js`
- `pull/oauth2-agents.js`
- `pull/services.js` (upstream: `amServices.js`)
- `pull/telemetry.js`
- `pull/connector-definitions.js`
- `pull/connector-mappings.js`
- `pull/remote-servers.js`
- `pull/secrets.js`
- `pull/secret-mappings.js`

### Push
- `push/update-managed-objects.js`
- `push/update-scripts.js`
- `push/update-auth-trees.js`
- `push/idm-flat-config.js` (generic — 5 upstream scripts folded into one)
- `push/update-password-policy.js`
- `push/update-org-privileges.js`
- `push/update-cookie-domains.js`
- `push/update-cors.js`
- `push/update-csp.js`
- `push/update-locales.js`
- `push/update-idm-endpoints.js`
- `push/update-internal-roles.js`
- `push/update-email-templates.js`
- `push/update-custom-nodes.js`
- `push/update-themes.js`
- `push/update-email-provider.js`
- `push/update-idm-schedules.js`
- `push/update-iga-workflows.js`
- `push/update-terms-and-conditions.js`
- `push/update-service-objects.js`
- `push/update-raw.js`
- `push/update-policies.js`
- `push/update-agents.js`
- `push/update-services.js`
- `push/update-telemetry.js`
- `push/update-connector-definitions.js`
- `push/update-connector-mappings.js`
- `push/update-remote-servers.js`
- `push/update-secrets.js`
- `push/update-secret-mappings.js`

## Scopes NOT vendored (still spawn to fr-config-push / fr-config-pull)

- **saml** — 170-line pull + 325-line push with XML + signing keys. Intentionally deferred: needs human review.
- **Frodo scopes** (`am-agents`, `oidc-providers`, `variables`) — require adopting `@rockcarver/frodo-lib` as an npm dependency with its own connection-state model. Intentionally deferred.
- **Direct-control / DCC staging** — handled in-process via the
  `setDirectControlMode(true)` toggle on `restClient` (see local patch
  #12). Vendored push functions can now run inside an open DCC session;
  no spawn is needed. The session lifecycle itself
  (`init` / `apply` / `abort` / `state`) is implemented in
  `src/lib/tenant-control.ts`.

## Local patches

1. **`pull/managed.js`** — filter loop uses `continue` instead of `return` so the
   `--name` filter works regardless of object order in the IDM response.
   Upstream bug at `scripts/managed.js:66`.
2. **`push/update-scripts.js`** — inner `pushScript` call is `await`ed.
   Upstream (`update-scripts.js:208`) fires the calls concurrently.
3. **`pull/journeys.js`** — `exportScriptById` and recursive `processJourneys`
   are `await`ed; `journeyCache` scoped per-call.
4. **`pull/password-policy.js`** — writes to `{exportDir}/realms/<realm>/...`
   instead of upstream's `{exportDir}/<realm>/...` (upstream pull+push don't
   round-trip otherwise).
5. **`push/update-password-policy.js`** — `continue`s to next realm when one
   has no config, instead of upstream's unconditional `return`.
6. **`pull/locales.js`** — awaits each per-locale GET (upstream doesn't).
7. **`pull/csp.js`** — dropped `cspOverridesFile` merge feature.
8. **`push/update-services.js`** — descendant push awaited sequentially
   (upstream uses unawaited `.map(async)` inside `Promise.all`).
9. **`push/update-idm-schedules.js`** — awaits each restPut (upstream doesn't).
10. **`push/update-secret-mappings.js`** — sequential awaited loop instead of
    concurrent Promise.all.
11. **`pull/iga-workflows.js`** — guard against non-array `result`. Tenants
    with no IGA workflows configured return a payload without `result`,
    which upstream iterates blindly and throws "workflows is not iterable".
    We treat that as "no workflows" and return cleanly so the scope
    succeeds instead of triggering retries + a hard failure.
12. **`common/restClient.js`** — adds module-level
    `setDirectControlMode(on)` / `getDirectControlMode()` and injects
    `X-Configuration-Type: mutable` on every request when on. Lets the
    in-process dispatcher run vendored push functions inside an open AIC
    DCC session (controlled-env promote) without spawning the upstream
    CLI. `fr-config-dispatch.ts` toggles the flag from
    `--direct-control` in `extraArgs`, in a try/finally.

## Security note

`push/update-secrets.js` emits only secret IDs, version numbers, and HTTP
verbs/URLs in its log callback — never secret values or request bodies.
Placeholder substitution (`${...}`) reads from envVars (defaults to process.env)
and base64-encodes on the fly. Review log statements if modifying.

## Sync process

1. Check upstream: `npm view @forgerock/fr-config-manager version`
2. If newer, fetch the tarball: `npm pack @forgerock/fr-config-manager@<version>`
3. Diff vendored files against upstream, port changes manually, re-apply the
   local patches above. Bump the version in this file when done.
