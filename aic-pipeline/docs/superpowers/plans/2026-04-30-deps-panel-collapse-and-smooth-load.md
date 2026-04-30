# Deps panel collapse + smooth title load — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the deps panel: defer rendering until titles resolve so labels never flash from id → attribute, and add a per-type chevron toggle to fold long groups out of the way.

**Architecture:** Both changes are local to `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx`. No API, lib, or persisted-state changes. The smooth load adds a `titlesLoading` boolean to `RecordDetailPane` that gates rendering of the type-group block; the collapse adds local `useState<boolean>(true)` to each `DepGroup` and hides the dep-button container when collapsed.

**Tech Stack:** React (`useState`, `useEffect`), Tailwind, TypeScript.

**Spec:** `aic-pipeline/docs/superpowers/specs/2026-04-30-deps-panel-collapse-and-smooth-load-design.md`

---

## File Structure

**Modify:**
- `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx` — both tasks live here.

No new files. No tests added (the underlying lib is already covered by `resolveTitles`'s six unit tests; this codebase has no UI tests for `BrowsePanel` / `RecordDetailPane` and we follow the established pattern).

---

## Task 1: Smooth title load

**Files:**
- Modify: `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx`

- [ ] **Step 1: Add `titlesLoading` state**

In `RecordDetailPane`, add the state declaration directly after the existing `titleReqIdRef = useRef(0)` line (currently line 106). Resulting block (around lines 100-107):

```tsx
const [outgoing, setOutgoing] = useState<{ type: string; id: string }[]>([]);
const [incoming, setIncoming] = useState<{ type: string; id: string }[]>([]);
const [depsLoading, setDepsLoading] = useState(false);
const [depsRequested, setDepsRequested] = useState(false);
const [titlesByRef, setTitlesByRef] = useState<Record<string, string | null>>({});
const [fieldsByType, setFieldsByType] = useState<Record<string, string[]>>({});
const [titlesLoading, setTitlesLoading] = useState(false);
const titleReqIdRef = useRef(0);
```

- [ ] **Step 2: Reset `titlesLoading` on record switch**

Extend the existing reset effect (currently lines 109-116) so a new record opens with `titlesLoading=false`:

```tsx
// Reset deps when the selected record changes
useEffect(() => {
  titleReqIdRef.current++;
  setOutgoing([]);
  setIncoming([]);
  setDepsRequested(false);
  setTitlesByRef({});
  setFieldsByType({});
  setTitlesLoading(false);
}, [env, type, id]);
```

- [ ] **Step 3: Drive `titlesLoading` from the titles-fetch effect**

Replace the existing titles-fetch effect (currently lines 170-192) with the version below. Changes vs. current: `setTitlesLoading(false)` in the empty-refs short-circuit, `setTitlesLoading(true)` at the start of the active fetch, and a `.finally` that flips it back off only when this fetch is still the active one.

```tsx
useEffect(() => {
  if (allRefs.length === 0) {
    titleReqIdRef.current++;
    setTitlesByRef({});
    setFieldsByType({});
    setTitlesLoading(false);
    return;
  }
  const reqId = ++titleReqIdRef.current;
  let cancelled = false;
  setTitlesLoading(true);
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
    .catch(() => { /* keep prior labels on transient failure */ })
    .finally(() => {
      if (!cancelled && reqId === titleReqIdRef.current) setTitlesLoading(false);
    });
  return () => { cancelled = true; };
}, [env, allRefs, attrsByTypeKey]);
```

- [ ] **Step 4: Gate the type-group block on `!titlesLoading`**

Replace the deps-body block (currently lines 255-301) so the type groups render only when titles are settled. While loading, show a single italicized "Loading dependencies…" line.

```tsx
{depsOpen && (
  <div className="px-3 pb-2 max-h-[200px] overflow-y-auto space-y-2 text-[11px]">
    {titlesLoading ? (
      <div className="text-slate-400 italic">Loading dependencies…</div>
    ) : (
      <>
        {/* Outgoing: records this one references */}
        {outgoing.length > 0 && (
          <div>
            <div className="text-slate-500 font-semibold mb-0.5">
              References <span className="font-normal text-slate-400">({outgoing.length})</span>
            </div>
            {[...outgoingByType.entries()].map(([refType, refs]) => (
              <DepGroup
                key={refType}
                refType={refType}
                refs={refs}
                fields={fieldsByType[refType] ?? []}
                chosen={titlePrefs[`${env}::${refType}`] ?? ""}
                env={env}
                titlesByRef={titlesByRef}
                onNavigate={onNavigate}
                onChooseField={setTitleFieldFor}
              />
            ))}
          </div>
        )}

        {/* Incoming: records that reference this one */}
        {incoming.length > 0 && (
          <div>
            <div className="text-slate-500 font-semibold mb-0.5">
              Referenced by <span className="font-normal text-slate-400">({incoming.length})</span>
            </div>
            {[...incomingByType.entries()].map(([refType, refs]) => (
              <DepGroup
                key={refType}
                refType={refType}
                refs={refs}
                fields={fieldsByType[refType] ?? []}
                chosen={titlePrefs[`${env}::${refType}`] ?? ""}
                env={env}
                titlesByRef={titlesByRef}
                onNavigate={onNavigate}
                onChooseField={setTitleFieldFor}
                titleSuffix=" → this record"
              />
            ))}
          </div>
        )}
      </>
    )}
  </div>
)}
```

- [ ] **Step 5: Type-check + lint + tests**

Run from `/Users/ledeng/projects/deloitte/ky/PingHub`:
```
cd aic-pipeline && npx tsc --noEmit
cd aic-pipeline && npm test
```
Expected: clean type-check, all tests pass (no test changes here; we're just confirming nothing regressed).

- [ ] **Step 6: Commit**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git add aic-pipeline/src/app/data/browse/RecordDetailPane.tsx
git commit -m "$(cat <<'EOF'
feat(data): defer deps render until titles settle

Eliminates the id → attribute label flicker by waiting for the titles
fetch before rendering the type groups. Empty-refs and titles-fetch
failure paths still settle to a stable state without indefinite
loading.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Expand/collapse per `DepGroup`

**Files:**
- Modify: `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx`

- [ ] **Step 1: Replace the `DepGroup` component**

Replace the existing `DepGroup` (currently lines 13-67) with the version below. Changes: a local `expanded` state defaulting to `true`, a chevron button containing the type name that toggles it, and conditional rendering of the dep-button container based on `expanded`. The `Display:` select stays in the header so it's reachable in both states. `cn` is already imported at the top of the file (line 6) — no new import needed.

```tsx
function DepGroup({
  refType, refs, fields, chosen, env,
  titlesByRef, onNavigate, onChooseField, titleSuffix = "",
}: {
  refType: string;
  refs: { type: string; id: string }[];
  fields: string[];
  chosen: string;
  env: string;
  titlesByRef: Record<string, string | null>;
  onNavigate?: (type: string, id: string) => void;
  onChooseField: (env: string, type: string, field: string) => void;
  titleSuffix?: string;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="ml-2 mb-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
          className="flex items-center gap-1 text-slate-400 hover:text-slate-600 transition-colors"
        >
          <svg
            className={cn("w-3 h-3 transition-transform", expanded && "rotate-90")}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span>{refType}</span>
        </button>
        {fields.length > 0 && (
          <label className="flex items-center gap-1 text-[10px] text-slate-500">
            <span>Display:</span>
            <select
              value={chosen}
              onChange={(e) => onChooseField(env, refType, e.target.value)}
              className="text-[11px] rounded border border-slate-300 bg-white px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky-400"
              title="Attribute used as the dependency label"
              aria-label={`Display attribute for ${refType}`}
            >
              <option value="">default</option>
              {fields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {expanded && (
        <div className="ml-2 flex flex-wrap gap-x-2 gap-y-0.5">
          {refs.map((r) => {
            const label = titlesByRef[`${r.type}/${r.id}`] ?? r.id;
            return (
              <button
                key={`${r.type}:${r.id}`}
                type="button"
                onClick={() => onNavigate?.(r.type, r.id)}
                title={`${r.type}/${r.id}${titleSuffix}`}
                className="font-mono text-sky-600 hover:underline hover:text-sky-800 truncate max-w-[240px]"
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Confirm `useState` is already imported**

The top of the file should already have `import { useEffect, useMemo, useRef, useState } from "react";`. If not, fix it. (It is — see line 4 of the current file.) No change needed.

- [ ] **Step 3: Type-check + lint + tests**

Run from `/Users/ledeng/projects/deloitte/ky/PingHub`:
```
cd aic-pipeline && npx tsc --noEmit
cd aic-pipeline && npm test
```
Expected: clean type-check, all tests pass.

- [ ] **Step 4: Manual smoke (deferred)**

The user will manually verify both Task 1 and Task 2 together after Task 2 lands. Do not start the dev server in the agent. The acceptance criteria the user will check:

- Click **Show Dependencies** for a record with attrs configured → labels appear with the chosen attribute on first paint, no UUID flash.
- Click a type's chevron → dep buttons hide; `Display:` selector remains visible. Click again → buttons reappear.
- Switch to another record → deps reset; new groups open expanded.

- [ ] **Step 5: Commit**

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub
git add aic-pipeline/src/app/data/browse/RecordDetailPane.tsx
git commit -m "$(cat <<'EOF'
feat(data): expand/collapse per dep type group

Each DepGroup now renders a chevron toggle alongside its type name.
State is local and resets when the selected record changes; the
Display selector remains visible in both states so users can change
the attribute without expanding.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist

- **Spec coverage:**
  - Smooth title load (Task 1): `titlesLoading` state added, set true on fetch start, false on settle/cancel-via-stale-token-check/failure; gates the type-group render with a "Loading dependencies…" line; reset effect zeros it on record switch; empty-refs path settles cleanly. ✅
  - Expand/collapse (Task 2): chevron + type-name button per `DepGroup`, default expanded, ephemeral state, `Display:` selector stays visible, dep-button container conditionally rendered. ✅
  - Out-of-scope items (persistence, refs+titles combined endpoint, animations) explicitly omitted. ✅

- **Placeholder scan:** No "TBD" / "TODO" / "fill in details". Every code block is complete and copy-pasteable.

- **Type/name consistency:** `titlesLoading` (boolean), `setTitlesLoading` (setter); `expanded` is local to `DepGroup`. No conflicts with prior tasks' identifiers (`titleReqIdRef`, `titlesByRef`, `fieldsByType`, `attrsByType`, `attrsByTypeKey`, `setTitleFieldFor`).
