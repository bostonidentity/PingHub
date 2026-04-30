# Dependency-list display attribute — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the user to choose which scalar attribute is used as the visible label for each dependency type group in `RecordDetailPane`, persisted per `(env, type)` and shared with the left-panel record list.

**Architecture:** A new lib function `resolveTitles` walks each referenced type's existing per-type SQLite index, picks the chosen attribute (case-insensitively, falling back to id), and returns titles plus the available scalar fields per type. A thin `POST /api/data/titles/[env]` exposes it. `BrowsePanel` lifts its `titlePrefs` setter so `RecordDetailPane` can read and update the same store; the deps panel renders a `Display:` `<select>` per type group, identical UX to the left toolbar.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest, better-sqlite3.

**Spec:** `aic-pipeline/docs/superpowers/specs/2026-04-30-deps-display-attr-design.md`

---

## File Structure

**Modify:**
- `aic-pipeline/src/lib/data/snapshot-fs.ts` — add `resolveTitles` exported helper alongside existing `readRecord` / `listRecords` (reuses the module-private `loadCache`).
- `aic-pipeline/src/lib/data/snapshot-fs.test.ts` — append a `describe("resolveTitles", …)` block.
- `aic-pipeline/src/app/data/browse/BrowsePanel.tsx` — generalize `setTitleFieldForCurrent` into `setTitleFieldFor(env, type, field)`, pass `titlePrefs` and the setter down to `RecordDetailPane`.
- `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx` — accept new props, fetch titles when refs settle or selector changes, render per-type `<select>` and resolved labels.

**Create:**
- `aic-pipeline/src/app/api/data/titles/[env]/route.ts` — POST handler, ~25 lines.

---

## Task 1: `resolveTitles` lib helper (TDD)

**Files:**
- Modify: `aic-pipeline/src/lib/data/snapshot-fs.ts`
- Test: `aic-pipeline/src/lib/data/snapshot-fs.test.ts` (append)

- [ ] **Step 1: Write failing tests for `resolveTitles`**

Append to `aic-pipeline/src/lib/data/snapshot-fs.test.ts` (after the existing `describe` blocks, before any final closer):

```ts
import { resolveTitles } from "./snapshot-fs";

async function buildType(type: string, records: Record<string, unknown>[]) {
  const dir = path.join(tmpDir, ENV, "managed-data", type);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_manifest.json"),
    JSON.stringify({ type, pulledAt: 1700000000000, count: records.length, jobId: "j1" }),
  );
  fs.writeFileSync(
    path.join(dir, "data.ndjson"),
    records.map((r) => JSON.stringify(r) + "\n").join(""),
  );
  await buildIndexFromNDJson(dir, (rec) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (k.startsWith("_") && k !== "_id") continue;
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
    return out;
  });
}

describe("resolveTitles", () => {
  it("resolves titles using the chosen attribute per type", async () => {
    await buildType("alpha_user", [
      { _id: "u1", userName: "alice", mail: "alice@x.co" },
      { _id: "u2", userName: "bob", mail: "bob@x.co" },
    ]);
    await buildType("alpha_role", [
      { _id: "r1", name: "admin" },
      { _id: "r2", name: "viewer" },
    ]);
    const out = await resolveTitles(tmpDir, ENV, [
      { type: "alpha_user", id: "u1" },
      { type: "alpha_user", id: "u2" },
      { type: "alpha_role", id: "r1" },
    ], { alpha_user: "userName", alpha_role: "name" });
    expect(out.titles).toEqual({
      "alpha_user/u1": "alice",
      "alpha_user/u2": "bob",
      "alpha_role/r1": "admin",
    });
    expect(out.fieldsByType.alpha_user).toContain("userName");
    expect(out.fieldsByType.alpha_role).toContain("name");
  });

  it("falls back to id when attr is empty, missing, or absent on the record", async () => {
    await buildType("alpha_user", [
      { _id: "u1", userName: "alice" },
      { _id: "u2" },
    ]);
    const out = await resolveTitles(tmpDir, ENV, [
      { type: "alpha_user", id: "u1" },
      { type: "alpha_user", id: "u2" },
    ], { alpha_user: "missingField" });
    expect(out.titles["alpha_user/u1"]).toBe("u1");
    expect(out.titles["alpha_user/u2"]).toBe("u2");
  });

  it("matches attribute case-insensitively", async () => {
    await buildType("alpha_user", [{ _id: "u1", UserName: "alice" }]);
    const out = await resolveTitles(tmpDir, ENV, [
      { type: "alpha_user", id: "u1" },
    ], { alpha_user: "username" });
    expect(out.titles["alpha_user/u1"]).toBe("alice");
  });

  it("returns null titles and empty fields for an unpulled type", async () => {
    const out = await resolveTitles(tmpDir, ENV, [
      { type: "alpha_user", id: "u1" },
    ], {});
    expect(out.titles["alpha_user/u1"]).toBeNull();
    expect(out.fieldsByType.alpha_user).toEqual([]);
  });

  it("returns null title for an id missing from a pulled type", async () => {
    await buildType("alpha_user", [{ _id: "u1", userName: "alice" }]);
    const out = await resolveTitles(tmpDir, ENV, [
      { type: "alpha_user", id: "ghost" },
    ], { alpha_user: "userName" });
    expect(out.titles["alpha_user/ghost"]).toBeNull();
  });

  it("handles empty refs without throwing", async () => {
    const out = await resolveTitles(tmpDir, ENV, [], {});
    expect(out.titles).toEqual({});
    expect(out.fieldsByType).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/data/snapshot-fs.test.ts -t resolveTitles`
Expected: FAIL — `resolveTitles is not exported / not a function`.

- [ ] **Step 3: Implement `resolveTitles` in `snapshot-fs.ts`**

Append to `aic-pipeline/src/lib/data/snapshot-fs.ts`, after `listRecords` and before `evictCache`:

```ts
export interface TitleRef { type: string; id: string }
export interface ResolveTitlesResult {
  /** key = `${type}/${id}`. null = type not pulled OR id not in that type's index. */
  titles: Record<string, string | null>;
  /** Sorted scalar fields per referenced type. [] when the type isn't pulled. */
  fieldsByType: Record<string, string[]>;
}

/**
 * Resolve a list of (type, id) refs to display titles using the chosen
 * attribute per type. Looks up `fields_json` from each type's SQLite index
 * (no NDJSON read), picks the attr case-insensitively, falls back to id.
 *
 * Used by the data tab's deps panel so users can label dependencies the
 * same way as the left-panel record list.
 */
export async function resolveTitles(
  envsRoot: string,
  env: string,
  refs: TitleRef[],
  attrs: Record<string, string>,
): Promise<ResolveTitlesResult> {
  const titles: Record<string, string | null> = {};
  const fieldsByType: Record<string, string[]> = {};
  if (refs.length === 0) return { titles, fieldsByType };

  // Group refs by type to issue one SQLite session per type.
  const byType = new Map<string, string[]>();
  for (const r of refs) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r.id);
  }

  for (const [type, ids] of byType.entries()) {
    const dir = path.join(managedDataDir(envsRoot, env), type);
    if (!existsSync(dir)) {
      fieldsByType[type] = [];
      for (const id of ids) titles[`${type}/${id}`] = null;
      continue;
    }
    const tc = await loadCache(dir);
    fieldsByType[type] = tc.fields;
    const attrWanted = attrs[type] ?? "";
    const stmt = tc.db.prepare("SELECT fields_json FROM records WHERE id = ?");
    for (const id of ids) {
      const row = stmt.get(id) as { fields_json: string } | undefined;
      if (!row) { titles[`${type}/${id}`] = null; continue; }
      if (!attrWanted) { titles[`${type}/${id}`] = id; continue; }
      try {
        const f = JSON.parse(row.fields_json) as Record<string, string>;
        const key = findKeyCI(f, attrWanted);
        const val = key ? f[key] : "";
        titles[`${type}/${id}`] = val || id;
      } catch {
        titles[`${type}/${id}`] = id;
      }
    }
  }

  return { titles, fieldsByType };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/data/snapshot-fs.test.ts -t resolveTitles`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add aic-pipeline/src/lib/data/snapshot-fs.ts aic-pipeline/src/lib/data/snapshot-fs.test.ts
git commit -m "$(cat <<'EOF'
feat(data): resolveTitles helper for dep-list labels

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: POST `/api/data/titles/[env]` route

**Files:**
- Create: `aic-pipeline/src/app/api/data/titles/[env]/route.ts`

- [ ] **Step 1: Create the route file**

```ts
// src/app/api/data/titles/[env]/route.ts
//
// Batch-resolve display titles for a list of (type, id) refs using the
// caller-chosen attribute per type. Used by the data-tab deps panel.

import { NextRequest, NextResponse } from "next/server";
import { resolveTitles, type ResolveTitlesResult, type TitleRef } from "@/lib/data/snapshot-fs";
import { ENVIRONMENTS_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";

export interface TitlesRequest {
  refs: TitleRef[];
  attrs: Record<string, string>;
}

export type TitlesResponse = ResolveTitlesResult;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ env: string }> },
) {
  const { env } = await params;
  let body: TitlesRequest;
  try { body = await req.json() as TitlesRequest; }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!Array.isArray(body.refs)) {
    return NextResponse.json({ error: "refs must be an array" }, { status: 400 });
  }
  const out = await resolveTitles(
    ENVIRONMENTS_DIR, env, body.refs, body.attrs ?? {},
  );
  return NextResponse.json(out satisfies TitlesResponse);
}
```

- [ ] **Step 2: Type-check**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add aic-pipeline/src/app/api/data/titles/[env]/route.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /api/data/titles/[env] for dep-label resolution

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Lift `setTitleFieldFor` and thread it through to `RecordDetailPane`

**Files:**
- Modify: `aic-pipeline/src/app/data/browse/BrowsePanel.tsx`

- [ ] **Step 1: Generalize the setter**

Replace the existing `setTitleFieldForCurrent` (around line 103-108) with a parameterized setter, and keep a thin wrapper for the current call site:

```tsx
function setTitleFieldFor(envName: string, type: string, field: string) {
  setTitlePrefs((prev) => {
    const next = { ...prev, [prefKey(envName, type)]: field };
    saveTitlePrefs(next);
    return next;
  });
}

function setTitleFieldForCurrent(field: string) {
  if (!selectedType) return;
  setTitleFieldFor(env, selectedType, field);
}
```

- [ ] **Step 2: Pass titlePrefs and setter to `RecordDetailPane`**

Find the `<RecordDetailPane … />` JSX (line 422 today) and add the two props:

```tsx
<RecordDetailPane
  env={env}
  type={selectedType}
  id={selectedId}
  onNavigate={jumpTo}
  titlePrefs={titlePrefs}
  setTitleFieldFor={setTitleFieldFor}
/>
```

- [ ] **Step 3: Type-check**

Run: `cd aic-pipeline && npx tsc --noEmit`
Expected: errors in `RecordDetailPane.tsx` only (props not yet declared) — fine, Task 4 fixes them.

- [ ] **Step 4: Commit**

```bash
git add aic-pipeline/src/app/data/browse/BrowsePanel.tsx
git commit -m "$(cat <<'EOF'
refactor(browse): lift title-pref setter for shared use

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `RecordDetailPane` — fetch titles, render per-type selector

**Files:**
- Modify: `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx`

- [ ] **Step 1: Update the props and imports**

Edit the imports block at the top of the file to add the response type and `useRef`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { JsonFileViewer } from "@/components/JsonFileViewer";
import { cn } from "@/lib/utils";
import type { RefsResponse } from "@/app/api/data/refs/[env]/[type]/[id]/route";
import type { GlobalSearchResponse } from "@/app/api/data/search/[env]/route";
import type { TitlesResponse } from "@/app/api/data/titles/[env]/route";
```

Update the `RecordDetailPane` signature to accept the new props:

```tsx
export function RecordDetailPane({
  env, type, id, onNavigate, titlePrefs, setTitleFieldFor,
}: {
  env: string;
  type: string | null;
  id: string | null;
  onNavigate?: (type: string, id: string) => void;
  titlePrefs: Record<string, string>;
  setTitleFieldFor: (env: string, type: string, field: string) => void;
}) {
```

- [ ] **Step 2: Add titles state + fetch effect**

Inside the component, after the existing `incoming`/`outgoing` state declarations and the existing reset effect for deps (around line 49), add:

```tsx
const [titlesByRef, setTitlesByRef] = useState<Record<string, string | null>>({});
const [fieldsByType, setFieldsByType] = useState<Record<string, string[]>>({});
const titleReqIdRef = useRef(0);

const allRefs = useMemo(
  () => [...outgoing, ...incoming],
  [outgoing, incoming],
);

const attrsByType = useMemo(() => {
  const types = new Set(allRefs.map((r) => r.type));
  const out: Record<string, string> = {};
  for (const t of types) {
    const v = titlePrefs[`${env}::${t}`];
    if (v) out[t] = v;
  }
  return out;
}, [allRefs, titlePrefs, env]);

useEffect(() => {
  if (allRefs.length === 0) {
    setTitlesByRef({});
    setFieldsByType({});
    return;
  }
  const reqId = ++titleReqIdRef.current;
  let cancelled = false;
  fetch(`/api/data/titles/${env}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refs: allRefs, attrs: attrsByType }),
  })
    .then((r) => r.ok ? r.json() as Promise<TitlesResponse> : null)
    .then((data) => {
      if (cancelled || reqId !== titleReqIdRef.current || !data) return;
      setTitlesByRef(data.titles);
      setFieldsByType(data.fieldsByType);
    })
    .catch(() => { /* keep prior labels on transient failure */ });
  return () => { cancelled = true; };
}, [env, allRefs, attrsByType]);
```

Also extend the existing reset effect (the one that depends on `[env, type, id]`) to clear titles too:

```tsx
useEffect(() => {
  setOutgoing([]);
  setIncoming([]);
  setDepsRequested(false);
  setTitlesByRef({});
  setFieldsByType({});
}, [env, type, id]);
```

- [ ] **Step 3: Render per-type Display selector + resolved title**

Replace the rendering of each type group inside both Outgoing and Incoming sections so each group shows the `Display:` `<select>` next to the type name and uses the resolved title for each button.

For the **Outgoing** section, swap the inner `[...outgoingByType.entries()].map(...)` block (around lines 152-169) for:

```tsx
{[...outgoingByType.entries()].map(([refType, refs]) => {
  const fields = fieldsByType[refType] ?? [];
  const chosen = titlePrefs[`${env}::${refType}`] ?? "";
  return (
    <div key={refType} className="ml-2 mb-1">
      <div className="flex items-center gap-2">
        <span className="text-slate-400">{refType}</span>
        {fields.length > 0 && (
          <label className="flex items-center gap-1 text-[10px] text-slate-500">
            <span>Display:</span>
            <select
              value={chosen}
              onChange={(e) => setTitleFieldFor(env, refType, e.target.value)}
              className="text-[11px] rounded border border-slate-300 bg-white px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
              title="Attribute used as the dependency label"
            >
              <option value="">default</option>
              {fields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ml-2 flex flex-wrap gap-x-2 gap-y-0.5">
        {refs.map((r) => {
          const label = titlesByRef[`${r.type}/${r.id}`] ?? r.id;
          return (
            <button
              key={`${r.type}:${r.id}`}
              type="button"
              onClick={() => onNavigate?.(r.type, r.id)}
              title={`${r.type}/${r.id}`}
              className="font-mono text-sky-600 hover:underline hover:text-sky-800 truncate max-w-[240px]"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
})}
```

For the **Incoming** section, apply the same shape — replace the inner `[...incomingByType.entries()].map(...)` block (around lines 179-196):

```tsx
{[...incomingByType.entries()].map(([refType, refs]) => {
  const fields = fieldsByType[refType] ?? [];
  const chosen = titlePrefs[`${env}::${refType}`] ?? "";
  return (
    <div key={refType} className="ml-2 mb-1">
      <div className="flex items-center gap-2">
        <span className="text-slate-400">{refType}</span>
        {fields.length > 0 && (
          <label className="flex items-center gap-1 text-[10px] text-slate-500">
            <span>Display:</span>
            <select
              value={chosen}
              onChange={(e) => setTitleFieldFor(env, refType, e.target.value)}
              className="text-[11px] rounded border border-slate-300 bg-white px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
              title="Attribute used as the dependency label"
            >
              <option value="">default</option>
              {fields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="ml-2 flex flex-wrap gap-x-2 gap-y-0.5">
        {refs.map((r) => {
          const label = titlesByRef[`${r.type}/${r.id}`] ?? r.id;
          return (
            <button
              key={`${r.type}:${r.id}`}
              type="button"
              onClick={() => onNavigate?.(r.type, r.id)}
              title={`${r.type}/${r.id} → this record`}
              className="font-mono text-sky-600 hover:underline hover:text-sky-800 truncate max-w-[240px]"
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
})}
```

- [ ] **Step 4: Type-check + lint**

Run: `cd aic-pipeline && npx tsc --noEmit && npx next lint`
Expected: no errors.

- [ ] **Step 5: Run the existing test suite**

Run: `cd aic-pipeline && npm test`
Expected: all green, including the six new `resolveTitles` cases.

- [ ] **Step 6: Manual verification**

Start the dev server (`cd aic-pipeline && npm run dev`) and:

1. In the data tab, select an env that has pulled types whose deps point to other pulled types (e.g. `sit` if `alpha_user` is pulled).
2. Pick a record, click **Show Dependencies**.
3. Confirm a `Display:` `<select>` appears next to each type label that has scalar fields. Pick a non-default attribute — labels in that group switch immediately.
4. Reload the page; the chosen attr persists and is applied to that group.
5. On the left panel, switch to the same type and confirm its column uses the same attribute.
6. Conversely, set an attr from the left panel for a type, then trigger **Show Dependencies** for a record that references that type — the deps panel uses the same attr without further input.
7. Click a dep that points to an unpulled type — the selector is hidden for that group and the id is shown (no regression).

- [ ] **Step 7: Commit**

```bash
git add aic-pipeline/src/app/data/browse/RecordDetailPane.tsx
git commit -m "$(cat <<'EOF'
feat(data): per-type display attr in deps panel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist

- Spec coverage: ✅ shared store (Task 3), per-type selector (Task 4), batch resolver (Tasks 1-2), graceful unpulled-type handling (Task 1 test #4 + Task 4 conditional render), id fallback (Task 1 test #2).
- No placeholders, no TODOs.
- Type names consistent across tasks: `TitleRef`, `ResolveTitlesResult`, `TitlesResponse`, `setTitleFieldFor(env, type, field)`.
- Out-of-scope items (the misleading "Record not found" message, cross-tab sync) explicitly deferred per spec.
