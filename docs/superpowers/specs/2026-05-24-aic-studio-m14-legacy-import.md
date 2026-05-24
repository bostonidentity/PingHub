# AIC Studio M14 — Legacy Bundle Import (Design Spec)

**Date:** 2026-05-24
**Branch target:** `aic-studio/m14` from `aic-studio/m13`
**Scope:** Add the ability to import environments from the Next.js (`aic-pipeline`) app's exported bundle JSON, including encrypted secrets, into AIC Studio.

---

## 1. Motivation

`aic-pipeline` users have invested effort configuring environments (tenant URLs, OAuth client IDs, log API keys, passwords). When they switch to `aic-studio`, those should not have to be re-entered by hand. The Next.js app already exports environments as a versioned, schema-tagged JSON bundle. AIC Studio should read that bundle and materialize the contained envs into its own SQLite + SecretStorage.

This is the **only direct migration path** from `aic-pipeline` to `aic-studio`; the prior decision (in the M1 brainstorm) was "fresh start on data". This spec walks that back partially: envs come over, but snapshots/promotion-tasks/monitor-state do not.

---

## 2. The legacy format (recap)

The Next.js app has one config export format — `BundleV1` (schema id `pinghub-environments/v1`). Both the multi-env "Export…" dialog and the per-env auto-backup write the same shape:

```jsonc
{
  "$schema": "pinghub-environments/v1",
  "exportedAt": "2026-05-24T...",
  "exportedBy": "user@example.com",      // optional
  "appVersion": "0.2.7.3",                // optional
  "secretsIncluded": true,
  "secretsEncryption": "passphrase-aes-256-gcm", // or "none"
  "kdf": { "algo": "pbkdf2", "hash": "sha256", "iter": 200000, "salt": "<base64>" },
  "environments": [
    {
      "meta": { "name": "dev", "label": "Dev", "color": "blue", "type": "..." },
      "envVars": {
        "TENANT_BASE_URL": "https://tenant.id.forgerock.io",
        "SERVICE_ACCOUNT_ID": "abcdef...",
        "FRODO_USERNAME": "...",
        "SERVICE_ACCOUNT_CLIENT_SECRET": { "_enc": "aes-256-gcm", "iv": "...", "tag": "...", "ct": "..." },
        "FRODO_PASSWORD": "<REDACTED>" // when secretsMode=exclude
        // ...
      },
      "files": {                          // optional companion JSONs
        "log-api.json": { "apiKey": "...", "apiSecret": "..." },
        "rcs-status.json": { ... },       // operational state, not config
        "release.json": { ... }
      }
    }
  ]
}
```

Three secret modes are produced by the exporter:
- **`exclude`** — secrets are replaced with the sentinel `"<REDACTED>"`. No `kdf`. Importer must surface "secret missing — set it after import".
- **`plain`** — secrets are inline strings. No `kdf`. Importer uses as-is.
- **`encrypted`** — secrets are `{ _enc: "aes-256-gcm", iv, tag, ct }` envelopes; `kdf` block describes how to derive the key from the passphrase via PBKDF2-SHA256 (200k iter by default).

Companion files are bundled inline under `entry.files[<filename>]` as parsed JSON.

---

## 3. Mapping (legacy → AIC Studio)

### 3.1 Environment fields

| Source | Destination | Notes |
|---|---|---|
| `entry.meta.name` | `Environment.name` | Must satisfy aic-studio's regex `^[a-z0-9][a-z0-9-_]*$`. If it doesn't, importer normalizes (lowercase + replace invalid chars with `-`) and reports the rename. |
| `entry.meta.label` | `Environment.label` | As-is. |
| `entry.meta.color` | `Environment.color` | Map via fallback table — aic-studio supports only `blue/green/yellow/red/slate`. Legacy `purple/orange/teal/pink/indigo/gray` → `slate`. |
| `entry.envVars.TENANT_BASE_URL` | `Environment.tenantUrl` | Required. If missing or not a URL, the env is reported as a failure with reason. |
| `entry.envVars.SERVICE_ACCOUNT_ID` | `Environment.clientId` | Required. Fallback chain: `SERVICE_ACCOUNT_ID` → `FRODO_SA_ID` → fail. |
| `entry.envVars.FRODO_USERNAME` | `Environment.username` | Fallback chain: `FRODO_USERNAME` → `SERVICE_ACCOUNT_ID` (re-use, since aic-studio requires non-empty). |

Other legacy `meta` fields (`type`, `devEnvironment`, `pageSize`, `healthIntervalMinutes`) are dropped — AIC Studio doesn't model those at v1.0.

### 3.2 Secrets

| Source | Destination secret kind |
|---|---|
| `envVars.SERVICE_ACCOUNT_CLIENT_SECRET` | `client-secret` |
| `envVars.FRODO_PASSWORD` | `password` |
| `envVars.LOG_API_KEY` OR `files["log-api.json"].apiKey` | `log-api-key` |
| `envVars.LOG_API_SECRET` OR `files["log-api.json"].apiSecret` | `log-api-secret` |

Precedence: `.env` values win over `log-api.json` companion (matches legacy app behavior). Skip writes where the resolved value is `"<REDACTED>"` or empty.

### 3.3 Companion files

- `log-api.json` — read for log-api-key/secret fallback (above). Don't store the file itself.
- `rcs-status.json`, `release.json` — operational state, not config. **Ignored.** (Future M-something could surface RCS status; deliberately out of scope.)

---

## 4. User experience

### 4.1 Surfaces

1. **Command palette:** `AIC Studio: Import Environments from Legacy Bundle…`
2. **Environments tree empty-state button:** When no envs exist, the tree's welcome-content shows `Add Environment` and `Import from aic-pipeline…` side-by-side. Clicking the latter runs the same command.

### 4.2 Flow

1. `vscode.window.showOpenDialog({ filters: { JSON: ["json"] }, canSelectMany: false })` → returns file URI.
2. Read file → `JSON.parse` → run `validateBundle` (structural check including `$schema` magic). If invalid: show error message; abort.
3. If `secretsEncryption === "passphrase-aes-256-gcm"`:
   - `vscode.window.showInputBox({ password: true, prompt: "Bundle passphrase", placeHolder: "Required to decrypt secrets" })`.
   - Empty/cancel → abort.
4. **Per-env preview**: show a `QuickPick<{ label: string, picked: boolean, action: "import"|"skip" }>` listing every env in the bundle with a conflict marker (`(exists — will need decision)`) for envs whose normalized name is already in the DB. User checks which to import.
5. **For each picked env with a conflict**, show a second `QuickPick<{ label, action: "skip"|"overwrite"|"rename" }>`. On `rename`, show `showInputBox({ prompt: "New name", value: "<original>-imported", validateInput: ... })`.
6. **Apply**:
   - Decrypt secrets (if needed).
   - Map fields per §3.
   - Write to DB via `insertEnvironment` / `updateEnvironment` (new helper for the overwrite case).
   - Write secrets to SecretStorage.
   - Capture a `pull`/`push`-style entry in `op_history` with `opKind = "import-legacy"` (new opKind value; see §5).
7. **Summary**: `vscode.window.showInformationMessage("Imported N · skipped M · failed K. View History for details.")` with a `Show History` button that opens the History tree filtered by the new op rows.

### 4.3 Failure modes (surfaced individually per env)

- Missing required env var (`TENANT_BASE_URL`, `SERVICE_ACCOUNT_ID`) — failure with reason.
- Decryption failed (wrong passphrase) — abort entire import, surface "passphrase did not decrypt the bundle".
- Name collision and user picked `skip` — counted as skipped.
- DB constraint violation (shouldn't happen with the per-env conflict-resolution flow, but caught defensively) — failure.

---

## 5. Data layer changes

### 5.1 Schema migration v7

Add `"import-legacy"` to the set of valid `op_kind` values stored in `op_history`. Today the column has no CHECK constraint, so this is **purely documentation** — no actual DDL change is required. The migration is a no-op SQL placeholder kept to keep `SCHEMA_VERSION` in sync if we later add CHECKs.

Decision: **skip the migration** to avoid no-op DB churn. Update the type union in code only. (Recorded here so future-me doesn't look for a v7.)

### 5.2 New `updateEnvironment` helper

Currently `src/core/db/environments.ts` has `insertEnvironment` / `removeEnvironment` but no in-place update. Add:

```ts
export function updateEnvironment(db: Database, input: NewEnvironment): void
```

— matches `insertEnvironment` signature; updates `label/tenantUrl/username/clientId/color` for a row matching `name`. Used by the overwrite branch.

---

## 6. Code layout

```
aic-studio/
  src/
    core/
      env/
        legacyBundle.ts                # NEW — types, validateBundle, decryptSecrets (port from aic-pipeline)
        legacyBundle.test.ts           # NEW — unit tests for parse + decrypt + redacted sentinel
        legacyImport.ts                # NEW — mapBundleEntryToEnvironment, mapBundleEntryToSecrets, planConflicts
        legacyImport.test.ts           # NEW
      types.ts                         # MODIFY — extend Environment color fallback table (or do mapping in legacyImport.ts only — chosen: keep types untouched)
      secrets.ts                       # No change
    core/db/
      environments.ts                  # MODIFY — add updateEnvironment
      environments.test.ts             # MODIFY — test updateEnvironment
      opHistory.ts                     # MODIFY — extend OpKind union with "import-legacy"
    commands/
      env.ts                           # MODIFY — register importFromLegacy command + entry point logic
      env.test.ts                      # MODIFY — sanity test
    providers/
      envTree.ts                       # MODIFY — add welcome view content for empty state
    extension.ts                       # No change (env.ts already wired)
  package.json                         # MODIFY — contribute command + viewsWelcome entry
  tests/integration/suite/
    importLegacy.test.ts               # NEW — extension-side smoke test (command registered, runs without rejecting given no input)
  CHANGELOG.md                         # MODIFY — M14 entry
```

---

## 7. Security and correctness

- **Crypto port is bit-identical.** The aic-pipeline implementation is straightforward Node `crypto` (PBKDF2 → AES-256-GCM with explicit `getAuthTag`). The port preserves iteration count, hash algorithm, IV/tag/ct base64 encoding, and salt length (16 bytes). A round-trip test confirms parity (encrypt with one impl, decrypt with the other — see test plan).
- **Passphrase never persisted.** Held in memory for the duration of the import command, then dropped. Not written to logs or `op_history`.
- **`<REDACTED>` sentinel** treated identically to missing (`""`) — never written to SecretStorage.
- **Path traversal:** `showOpenDialog` returns trusted URIs; no traversal risk. We do not honor any path from inside the bundle.
- **No automatic activation of imported env.** User must explicitly `setActive` after import. Avoids surprise OAuth calls against the new tenant.

---

## 8. Testing strategy

### 8.1 Unit (vitest)
- `legacyBundle.test.ts`
  - Parses minimal `plain` bundle → success.
  - Parses missing `$schema` → throws "unsupported bundle schema".
  - Decrypts an encrypted bundle round-trip (fixture generated in test setup, since we have access to both encrypt+decrypt code paths after port).
  - Wrong passphrase → throws.
  - Redacted sentinel preserved as-is.
- `legacyImport.test.ts`
  - Maps a full plain bundle → `Environment[]` with secrets payload, no conflicts.
  - Detects conflicts vs existing DB envs.
  - Normalizes a bad name (`Prod-East` → `prod-east`).
  - Color fallback (`purple` → `slate`).
  - log-api.json companion fallback when `LOG_API_KEY` absent.
  - Throws/reports failure when `TENANT_BASE_URL` missing.
- `environments.test.ts` (extension): `updateEnvironment` happy path + name-not-found.

### 8.2 Integration (@vscode/test-electron)
- `importLegacy.test.ts`
  - `aic-studio.env.importFromLegacy` command is registered.
  - Invoking with no file selected (canceled showOpenDialog stubbed out via test-mode shim) does not reject.

### 8.3 Out of scope
- Full end-to-end import using a recorded fixture bundle — would need to record one against a real legacy app. Defer to the manual smoke pass.

---

## 9. Out of scope (called out explicitly)

- Snapshots: not imported. AIC Studio pulls fresh; legacy snapshots are git-versioned anyway.
- Promotion tasks: not exported by the legacy app, so nothing to import.
- Git settings, monitor state, RCS data, IGA workflows: operational state, not user config.
- A reverse export (aic-studio → bundle.json) — not requested; defer.
- Re-import / merge mode that preserves live secrets across re-imports of the same env — covered by the per-env "skip/overwrite/rename" UX; an automatic "merge preserving live" mode (which the legacy app has) is overkill for the migration use case.

---

## 10. Acceptance criteria

- Importing a plaintext bundle with 3 envs results in 3 environments in the tree, each with the correct tenant URL / client ID / username / color.
- Importing an encrypted bundle prompts for passphrase; correct passphrase decrypts all secrets; wrong passphrase aborts without partial writes.
- Importing a bundle where one env's name collides surfaces the conflict UI; chosen action (skip/overwrite/rename) is honored.
- Importing a bundle missing `TENANT_BASE_URL` for one entry reports that one as failed and proceeds with the others.
- Empty Environments tree shows the "Import from aic-pipeline…" welcome button alongside "Add Environment".
- `npm test` + `npm run test:integration` + `npm run typecheck` + `npm run build` all pass on `aic-studio/m14`.
- CHANGELOG has an M14 entry.

---

## Self-review

1. **Placeholder scan:** No TBDs, no "TODO". ✓
2. **Internal consistency:** §3 mapping aligns with §5 schema (no `username` added since aic-studio already requires it; we use the FRODO_USERNAME fallback). §4.3 failure modes are all surfaced in §10 acceptance criteria. ✓
3. **Scope check:** Single feature, single milestone, single command + supporting helpers. Appropriate for one plan. ✓
4. **Ambiguity check:** §3.1 spelled out the normalization rule for invalid names. §3.2 spelled out the precedence between `.env` and companion file. §5.1 explicitly resolved the "do we need a migration?" question (no). ✓

Spec ready.
