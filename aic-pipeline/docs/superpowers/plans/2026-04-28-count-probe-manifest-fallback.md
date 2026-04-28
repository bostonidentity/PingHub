# Count Probe — Manifest Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the live tenant count probe fails (rejected `_countPolicy`, pagination cap exceeded, network error), fall back to the local snapshot's `_manifest.json.count` if a previous pull exists, and show the count in the UI with an `*` marker so users can see it's snapshot-derived rather than live.

**Architecture:** Two surgical edits in two files. The server inserts a manifest-read step between the failing tenant probes and the slow ID-only pagination fallback. The client surfaces the new `reason` field for non-null counts with the existing `*` convention from `JobCard.tsx`.

**Tech stack:** Next.js 16 App Router, TypeScript, React 19, Vitest. Tests run with `npx vitest run <path>` (single file) or `npm test` (full suite). All paths are relative to the repo root unless prefixed with `aic-pipeline/`.

**Spec:** `aic-pipeline/docs/superpowers/specs/2026-04-28-count-probe-manifest-fallback-design.md`

---

## File map

**Modified files:**
- `aic-pipeline/src/app/api/data/count/[env]/route.ts` — widen `ProbeResult` type to allow `reason` on non-null counts; insert manifest-fallback step in `probeType` between `ESTIMATE` and the pagination loop.
- `aic-pipeline/src/app/data/pull/PullPanel.tsx` — surface `reason` on non-null counts with `*` marker and italic styling; tooltip combines count + reason.

**No new files. No new tests** (no existing test infrastructure for these two files; the change is small and isolated, and verification is via `tsc --noEmit`, `npm test` regression, and a manual smoke).

---

## Task 1: Server — manifest fallback in count route

**Files:**
- Modify: `aic-pipeline/src/app/api/data/count/[env]/route.ts`

- [ ] **Step 1: Widen the `ProbeResult` type to allow `reason` alongside a non-null count.**

In `aic-pipeline/src/app/api/data/count/[env]/route.ts`, find the type alias on line 38:

```ts
type ProbeResult = { count: number } | { count: null; reason: string };
```

Replace it with:

```ts
type ProbeResult =
  | { count: number; reason?: string }
  | { count: null; reason: string };
```

This change lets the manifest-fallback path return `{ count: 504231, reason: "from local snapshot pulled ..." }` while keeping the existing `{ count: null; reason: "..." }` failure shape unchanged. The non-null branch already had `count: number` — we're only adding an optional `reason`.

- [ ] **Step 2: Add a manifest-read helper near the top of the file.**

In the same file, just after the existing `envVarsFor` function (around lines 32–36), insert:

```ts
function readManifestCount(env: string, type: string): { count: number; pulledAt: number } | null {
  const manifestPath = path.join(ENVIRONMENTS_DIR, env, "managed-data", type, "_manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      count?: unknown;
      pulledAt?: unknown;
    };
    if (typeof data.count !== "number" || data.count < 0) return null;
    if (typeof data.pulledAt !== "number") return null;
    return { count: data.count, pulledAt: data.pulledAt };
  } catch {
    return null;
  }
}
```

This helper is intentionally synchronous and self-contained: it returns the manifest's `count` and `pulledAt` if present and valid, else null. The route's `probeType` is async but this read is fast enough that sync I/O is fine — the alternative (`fsp.readFile`) just adds noise without saving wall time.

- [ ] **Step 3: Insert the manifest fallback in `probeType`.**

In the same file, find the `probeType` function (currently around lines 70–113). The current EXACT/ESTIMATE preamble is:

```ts
async function probeType(
  tenantUrl: string,
  type: string,
  token: string,
  emit: (ev: ProbeEvent) => void,
): Promise<ProbeResult> {
  const exact = await probePolicy(tenantUrl, type, token, "EXACT");
  if (exact.count !== null) return exact;
  const estimate = await probePolicy(tenantUrl, type, token, "ESTIMATE");
  if (estimate.count !== null) return estimate;

  // Paginated ID-only count fallback. Progress events fire after each page.
  let cookie: string | null = null;
  ...
}
```

We need to know which `env` we're probing for inside `probeType` to read the right manifest. The function signature today doesn't take `env` — we'll add it. Update the function signature and the single call site.

(a) Change the signature. Replace the full function declaration line:

```ts
async function probeType(
  tenantUrl: string,
  type: string,
  token: string,
  emit: (ev: ProbeEvent) => void,
): Promise<ProbeResult> {
```

with:

```ts
async function probeType(
  tenantUrl: string,
  env: string,
  type: string,
  token: string,
  emit: (ev: ProbeEvent) => void,
): Promise<ProbeResult> {
```

(b) Insert the manifest fallback. Just after the ESTIMATE check (after `if (estimate.count !== null) return estimate;`), and before the pagination loop's `let cookie: string | null = null;`, insert:

```ts
  // Manifest fallback: if both EXACT and ESTIMATE failed AND the type has
  // been pulled before, return the snapshot's count. Skips the slow
  // pagination fallback entirely. The `reason` field tags the value so the
  // UI can show it differently from a live tenant count.
  const manifest = readManifestCount(env, type);
  if (manifest) {
    const isoMinute = new Date(manifest.pulledAt).toISOString().slice(0, 16) + "Z";
    return {
      count: manifest.count,
      reason: `from local snapshot pulled ${isoMinute}`,
    };
  }
```

(c) Update the single call site of `probeType`. Find it inside the `for (const type of types)` loop in the route's `start(controller)` body (currently around line 162):

```ts
        const r = await probeType(tenantUrl, type, token, emit);
```

Replace with:

```ts
        const r = await probeType(tenantUrl, env, type, token, emit);
```

- [ ] **Step 4: Update the `done` event emission to forward `reason` when set on a non-null count.**

In the same file, find the `done` event emission (currently around line 163):

```ts
        emit({ event: "done", type, count: r.count, reason: r.count === null ? (r as { reason: string }).reason : undefined });
```

The condition `r.count === null` was correct under the OLD type (only null-count results had `reason`). Now non-null results may also have `reason` (when sourced from manifest). Replace with:

```ts
        emit({ event: "done", type, count: r.count, reason: r.reason });
```

`r.reason` is `string | undefined` after the type widening from Step 1, so this just forwards whatever the probeType result has. The client already accepts `reason?: string` on the `done` event.

- [ ] **Step 5: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full test suite.**

Run: `cd aic-pipeline && npm test`
Expected: all tests pass (existing 419/419 — no new tests added in this task).

- [ ] **Step 7: Commit.**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git add aic-pipeline/src/app/api/data/count/[env]/route.ts
git commit -m "$(cat <<'EOF'
feat(count): manifest fallback when tenant probe fails

When _countPolicy=EXACT and ESTIMATE both fail (e.g. UAT tenant rejects
the parameter) AND the type's _manifest.json exists from a prior pull,
return the manifest's count instead of falling through to the slow
pagination cap. Tags the result with reason="from local snapshot pulled
<iso>" so the UI can distinguish snapshot-derived counts from live ones.

Live tenant counts (when the tenant supports _countPolicy) are
unchanged. Types never pulled fall through to pagination as before.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Client — surface reason on non-null counts

**Files:**
- Modify: `aic-pipeline/src/app/data/pull/PullPanel.tsx`

The store and `recordProbe` already accept and persist `reason` for any count (null or not). The only piece missing is rendering: today the count cell ignores `countReasons[t]` when the count is non-null. We change that so the user sees the `*` marker plus a tooltip that explains the source.

- [ ] **Step 1: Update the count cell renderer to surface `reason` on non-null counts.**

In `aic-pipeline/src/app/data/pull/PullPanel.tsx`, find the count `<span>` block (currently around lines 358–365):

```tsx
                ) : has ? (
                  <span
                    className={c === null ? "text-[10px] text-slate-400 italic cursor-help" : "text-[10px] text-slate-500 font-mono tabular-nums"}
                    title={c === null ? (countReasons[t] ?? "Tenant declined to report a count") : `${c} records`}
                  >
                    {c === null ? "unknown" : c.toLocaleString()}
                  </span>
                ) : null}
```

Replace with:

```tsx
                ) : has ? (
                  (() => {
                    const reason = countReasons[t];
                    const isSnapshotSourced = c !== null && !!reason;
                    const className = c === null
                      ? "text-[10px] text-slate-400 italic cursor-help"
                      : isSnapshotSourced
                        ? "text-[10px] text-slate-500 italic font-mono tabular-nums cursor-help"
                        : "text-[10px] text-slate-500 font-mono tabular-nums";
                    const title = c === null
                      ? (reason ?? "Tenant declined to report a count")
                      : isSnapshotSourced
                        ? `${c.toLocaleString()} records — ${reason}`
                        : `${c.toLocaleString()} records`;
                    return (
                      <span className={className} title={title}>
                        {c === null ? "unknown" : isSnapshotSourced ? `${c.toLocaleString()}*` : c.toLocaleString()}
                      </span>
                    );
                  })()
                ) : null}
```

The `(() => { ... })()` IIFE keeps the local helpers (`reason`, `isSnapshotSourced`, `className`, `title`) close to the JSX without polluting the parent component's body.

Behavior:

| `c` | `reason` | Renders | Tooltip |
|---|---|---|---|
| number | unset | `123,456` plain | `123,456 records` |
| number | set | `123,456*` italic | `123,456 records — from local snapshot pulled ...` |
| null | unset | `unknown` italic | `Tenant declined to report a count` |
| null | set | `unknown` italic | `<reason from server>` |

- [ ] **Step 2: Type-check.**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the full test suite.**

Run: `cd aic-pipeline && npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit.**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git add aic-pipeline/src/app/data/pull/PullPanel.tsx
git commit -m "$(cat <<'EOF'
feat(pull-panel): surface snapshot source on non-null probe counts

Manifest-fallback counts now render with a trailing * and italic styling
to distinguish them from live tenant counts. The tooltip combines the
count with the reason so users can see the snapshot's pulled-at
timestamp at a glance.

Live tenant counts (no reason) render plain as before.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Final green check + handed-back manual smoke

**Files:** none (validation only)

- [ ] **Step 1: Run the full quality gate.**

```bash
cd aic-pipeline && npx tsc --noEmit
cd aic-pipeline && npm run lint
cd aic-pipeline && npm test
```

All three must succeed (no errors). Pre-existing lint warnings in unrelated files are fine; new ones on the two files touched in this work would need fixing.

- [ ] **Step 2: Hand back to user for manual smoke.**

The user runs the dev server and validates the spec's 5 acceptance scenarios against UAT and a sandbox env:

1. Probe `alpha_kyid_access` in UAT (which has been pulled). Expect `<count>*` italic + tooltip showing pulled-at.
2. Probe a UAT type that has NOT been pulled and is large (>200k rows). Expect `unknown` (current behavior).
3. Probe a UAT type that has NOT been pulled and is small. Expect plain count (no `*`).
4. Probe in a sandbox env where `_countPolicy` works. Expect plain live count (no `*`), even if a manifest exists.
5. After a fresh re-pull of any type, probe again — expect the value to reflect the new manifest's count and the new `pulledAt`.

Subagent's job ends after Step 1. Step 2 is for the user.

---

## Self-review notes

**Spec coverage:**
- Spec § "Approach > Server change" → Task 1 (signature update + manifest helper + insertion + done-event reason forwarding) ✓
- Spec § "Approach > Client change" → Task 2 (IIFE-based render with `*` marker + tooltip) ✓
- Spec § "Behavior matrix" → maps directly to the rendering table in Task 2 ✓
- Spec § "Acceptance" → Task 3 manual smoke ✓
- Spec § "Risks" → captured as inline guards (parse try/catch, type checks on count + pulledAt) ✓
- Spec § "Out of scope" → no tasks here, by design ✓

**Placeholder scan:** no TBD/TODO; every step has concrete code or exact commands. Manual smoke in Task 3 Step 2 is what the spec calls for.

**Type / name consistency:**
- `readManifestCount` returns `{ count: number; pulledAt: number } | null` — consistent across Task 1 step 2 and step 3.
- `ProbeResult` widened in step 1, used in steps 3 + 4 — consistent.
- The `reason` string format `"from local snapshot pulled <ISO-minute>"` is constructed in Task 1 step 3, surfaced in Task 2 step 1 verbatim — consistent.
- `isSnapshotSourced` is the single derived flag in Task 2, used for both className and rendering.

---

## Notes for the implementing engineer

- **No new tests.** The two affected files have no existing unit tests, and the change is small/isolated. Manual smoke in Task 3 is the verification.
- **Commit locally only; do not push.** The user pushes manually.
- **Stage only the listed files in each task** — no `git add -A`.
- **Don't `--no-verify`** on commits.
- The Co-Author trailer is required in commit messages (use the HEREDOC pattern shown).
- The repo's `aic-pipeline/AGENTS.md` warns Next.js APIs may differ from training data; this work doesn't touch any Next.js APIs (just route handler internals + a React component), so that caveat is informational only.
