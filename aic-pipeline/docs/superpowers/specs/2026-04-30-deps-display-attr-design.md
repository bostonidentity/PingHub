# Dependency-list display attribute

Allow the user to choose which scalar attribute is used as the visible label for each dependency in `RecordDetailPane`'s deps panel — same UX as the left-panel record list. Selection persists per `(env, type)` and is shared with the left panel.

## Motivation

Today the deps panel renders raw record IDs. Users browsing references jump to records they cannot recognize without opening each one. The left panel already lets them pick a more meaningful column (e.g. `userName`); deps should benefit from the same preference.

## Behavior

- Each type group inside Dependencies (References / Referenced by) gains a compact `Display:` `<select>` next to the type label. Options are `default` plus that type's scalar fields, identical to the left toolbar.
- Choosing a field updates the per-`(env,type)` preference. The left-panel list reflects the change immediately when that type is selected on the left, and vice versa: a preference set on the left already applies to the deps panel.
- Each dep button shows the resolved title; the id moves to the `title` tooltip.
- If a dep type is not pulled (no `index.sqlite`), the selector is hidden for that group and dep buttons fall back to the id (current behavior).

## Architecture

### Shared preference store

`titlePrefs: Record<\`${env}::${type}\`, string>` already lives in `BrowsePanel` (localStorage key `data-browse-title-pref-v1`). It becomes the single source of truth for both panels. `BrowsePanel` passes:

- `titlePrefs`
- `setTitleFieldFor(env: string, type: string, field: string): void`

into `RecordDetailPane`. The existing `setTitleFieldForCurrent` is refactored to call the generalized setter.

### New API: `POST /api/data/titles/[env]`

Request body:

```ts
{
  refs: { type: string; id: string }[];
  attrs: Record<string, string>; // type -> chosen field; "" or missing means default
}
```

Response:

```ts
{
  titles: Record<string, string | null>; // key = `${type}/${id}`; null = unknown / not pulled
  fieldsByType: Record<string, string[]>; // sorted scalar fields per referenced type, [] when type not pulled
}
```

Implementation: group refs by type. For each type:

1. Resolve `typeDir = managed-data/<type>`. If missing, contribute `[]` to `fieldsByType` and `null` titles for its refs.
2. Otherwise reuse `loadCache(typeDir)` (already exposed via `snapshot-fs.ts`) to get the open SQLite handle and `fields[]`.
3. For each id in the group, run a single `SELECT fields_json FROM records WHERE id IN (...)` (chunked to a safe SQLite parameter limit, e.g. 500). Parse `fields_json`, look up the attr from `attrs[type]` case-insensitively (mirroring `findKeyCI` in `snapshot-fs.ts`), fall back to the id when absent.

The endpoint stays synchronous and returns in a single round-trip — no streaming.

### Detail-pane wiring

`RecordDetailPane` already lazy-loads refs. After `setOutgoing`/`setIncoming` settle, it calls the titles endpoint with the union of refs and the current `attrs` map (built from `titlePrefs`). Result populates two new pieces of state:

- `titlesByRef: Record<\`${type}/${id}\`, string | null>`
- `fieldsByType: Record<string, string[]>`

When the user changes a per-type selector, the component:

1. Calls `setTitleFieldFor(env, type, field)` (lifted setter).
2. Re-fetches titles for that one type's refs (or the full set — both are cheap; pick the simpler full refetch).

A request token guards against out-of-order responses.

## Edge cases

- **Type not pulled** — `fieldsByType[type]` is `[]`; selector hidden; titles fall back to id.
- **Record id not in SQLite** (stale ref) — title is `null`; UI shows the id (today's behavior).
- **Empty refs** — skip the titles fetch entirely.
- **Race with attr change** — last-issued request wins; older responses discarded by token.

## Out of scope

- Fixing the misleading "Record not found" message when a dep points to an unpulled type (separate change discussed earlier).
- Showing non-scalar (object/array) attributes as labels.
- Cross-tab sync of preference changes.

## Test plan

- Unit-test the new endpoint: mixed pulled/unpulled types, missing ids, attr override per type, empty input.
- Component test: changing the selector in the deps panel updates `titlePrefs` and persists; left panel reflects the new field after switching back to that type.
- Manual: in the data tab, click "Find Dependencies", change `Display:` for a type group, reload the page, confirm selection sticks; switch left panel to that type and confirm the same attribute is in use.
