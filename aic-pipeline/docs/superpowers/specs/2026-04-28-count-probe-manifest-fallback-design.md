# Count Probe — Manifest Fallback for Pulled Snapshots

**Status:** Design — pending implementation plan
**Date:** 2026-04-28

## Problem

The Data tab's count probe shows "unknown" for any managed-object type whose live tenant count cannot be determined. In the UAT environment, this affects every type because the tenant rejects `_countPolicy` (HTTP 400) on both `EXACT` and `ESTIMATE` policies, and any type larger than 200,000 records also exceeds the ID-only pagination fallback's `PAGINATION_COUNT_CAP`. The concrete trigger: `alpha_tenant_access` shows "unknown" even after a successful pull, because nothing in the probe code path consults the on-disk snapshot.

After a pull completes, `environments/{env}/managed-data/{type}/_manifest.json` contains an exact `count`. Surfacing that to the probe UI eliminates the "unknown" state for types that have been pulled at least once, with no extra tenant traffic.

## Goal

When the live tenant probe yields no count (any reason — `_countPolicy` rejection, pagination cap, network error), fall back to the local snapshot's manifest count if a recent pull exists. Distinguish snapshot-derived counts from live-tenant counts in the UI so users can judge staleness.

## Non-goals

- No change to the live tenant probe path (`_countPolicy=EXACT` and `_countPolicy=ESTIMATE`). Tenants that support those still take the fast path and produce a real-time count.
- No raise/removal of the 200,000-row pagination cap.
- No probe retry/backoff or cancel UI.
- No automatic re-probe after a pull completes — user clicks Probe themselves; it's near-instant once the manifest exists.
- No change to the per-record `_index.json` or `_refs.json` files.
- No change to `JobCard.tsx`'s existing `*` marker convention (which already distinguishes probe-sourced denominators).

## Approach

Two surgical changes in two files.

### Server change — manifest fallback in `count/[env]/route.ts`

The `probeType` function currently runs:

1. `_countPolicy=EXACT` (one round-trip)
2. `_countPolicy=ESTIMATE` (one round-trip)
3. ID-only pagination at `_pageSize=1000`, capped at 200,000 records

Insert a new step between #2 and #3: read `path.join(envsRoot, env, "managed-data", type, "_manifest.json")`. If the file exists and parses to an object with a non-negative numeric `count` and numeric `pulledAt`, return:

```ts
{
  count: manifest.count,
  reason: `from local snapshot pulled ${new Date(manifest.pulledAt).toISOString().slice(0, 16)}Z`,
}
```

For example: `"from local snapshot pulled 2026-04-28T14:32Z"`.

If the manifest is absent, malformed, or missing fields, fall through to the existing pagination fallback (current behavior preserved).

The route's existing `done` event already supports `reason` alongside `count`. Today the runtime only sets `reason` when `count === null`. With this change, `reason` is also set when the count came from a snapshot. The event payload type doesn't need to change.

### Client change — surface the source in `PullPanel.tsx`

The probed-counts store already keeps `{ count, reason, probedAt }` per type — no schema change.

Update the count cell renderer (currently around `PullPanel.tsx:358-365`):

- When `c !== null && reason`: append `*` to the formatted count and apply italic styling (`text-slate-500 italic font-mono tabular-nums`). This matches the existing `*` convention in `JobCard.tsx` for probe-sourced denominators.
- When `c !== null && !reason`: render plain (current behavior — live tenant count).
- When `c === null`: render `"unknown"` with the failure-reason tooltip (current behavior).

Tooltip:

- `c !== null && reason` → `${c.toLocaleString()} records — ${reason}`
- `c !== null && !reason` → `${c.toLocaleString()} records` (current)
- `c === null` → existing failure-reason tooltip

## Behavior matrix

| Tenant supports `_countPolicy`? | Manifest exists? | UI shows | Tooltip |
|---|---|---|---|
| Yes | Either | `504,231` | `504,231 records` |
| No | Yes | `504,231*` (italic) | `504,231 records — from local snapshot pulled 2026-04-28T14:32Z` |
| No | No, type ≤ 200k rows | `<paginated count>` | `<paginated count> records` |
| No | No, type > 200k rows | `unknown` | failure-reason from pagination cap |
| Network error or 5xx mid-probe | Yes | `504,231*` (italic) | `... — from local snapshot pulled ...` |
| Network error or 5xx mid-probe | No | `unknown` | failure-reason from pagination |

## Acceptance

After this ships, in UAT:

1. Probe `alpha_tenant_access` (which has been pulled). UI shows the manifest count with `*` and italic styling. Tooltip on hover shows the pulled-at timestamp.
2. Probe a UAT type that has NOT been pulled and is large. UI shows `unknown` (current behavior, unchanged).
3. Probe a UAT type that has NOT been pulled and is small enough to paginate within the cap. UI shows the paginated count plain (no `*`).
4. Probe a sandbox env type where `_countPolicy` works. UI shows live count plain (no `*`), even if a manifest exists — live tenant count wins.
5. After a fresh pull of `alpha_tenant_access`, click Probe again — count value reflects the new pull's manifest (i.e., manifest is read on every probe, not cached).

Manual smoke covers all five. No new unit tests — there's no existing test infrastructure for the count route, and the change is a small, isolated read-from-disk branch.

## Risks

- **Stale manifest count** — if the tenant has added/deleted records since the pull, the count is wrong. The `*` marker + tooltip make this explicit. Acceptable trade-off vs. "unknown."
- **Race during pull completion** — if a probe happens during the atomic-swap window when the manifest is being written, the read could yield a partial file. The pull-runner writes `_manifest.json` AFTER the dir is renamed into place (per `pull-runner.ts:297-299`), so by the time the file is visible at the canonical path, it's complete. Low risk.
- **Manifest schema drift** — the read parses with a try/catch and validates `count` is a non-negative number. Any future schema change that drops `count` falls through to pagination naturally.
