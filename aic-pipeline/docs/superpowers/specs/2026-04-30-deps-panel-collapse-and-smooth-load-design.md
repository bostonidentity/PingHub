# Dependency-list polish: expand/collapse + smooth title load

Two small UX improvements to the deps panel inside `RecordDetailPane`:

1. Each type group gets an expand/collapse toggle.
2. Dep groups don't render until titles are resolved — eliminating the "UUID flash, then switch to attribute" flicker.

## Motivation

Today, after clicking **Show Dependencies**:

- Refs return → groups render with `r.id` as the label.
- Titles return ~tens to hundreds of milliseconds later → labels swap from id to the chosen attribute.

For records with many dep groups or many refs per type, the swap is visible and feels janky. Users also want a way to fold long type groups out of the way.

## Behavior

### Expand/collapse

- Each `DepGroup` shows a chevron next to the type name. Clicking the chevron (or the type label) toggles the group.
- Default state: expanded.
- State is local to the `DepGroup` instance and resets when the selected record changes (refs reload, fresh `DepGroup`s mount). No persistence.
- The `Display:` selector is part of the group header and remains visible regardless of expanded/collapsed state.
- The dep buttons inside the group are what get hidden when collapsed.

### Smooth title load

- Add `titlesLoading: boolean` to `RecordDetailPane`. Set `true` when the titles fetch starts, `false` when it settles or fails.
- While `titlesLoading` is true (and refs are present), the deps panel body shows a single "Loading dependencies…" line instead of the type groups.
- When titles settle, render all type groups in one paint — labels are correct from the first frame.
- On titles-fetch failure, set `titlesLoading=false` so groups render with id-fallback labels (current behavior). Don't get stuck on the loading line.
- Empty refs path is unchanged ("No dependencies found.").

## Architecture

Both changes are local to `aic-pipeline/src/app/data/browse/RecordDetailPane.tsx`. No API, lib, or schema changes.

### Expand/collapse

`DepGroup` maintains its own `useState<boolean>(true)` for expanded. The chevron + type label become a clickable button that toggles it. The dep-button container renders only when expanded. The `Display:` select stays in the header so users can change the attribute without expanding the list.

### Smooth title load

Add `titlesLoading` state to `RecordDetailPane`. Wire the existing titles-fetch effect to set it `true` at start and `false` in the settle / catch / cancel paths. In the existing `depsRequested && (depsLoading || hasDeps)` block, gate the type-group rendering on `!titlesLoading`. Show "Loading dependencies…" otherwise.

The reset effect (deps `[env, type, id]`) sets `titlesLoading=false` along with clearing `titlesByRef`/`fieldsByType`, so a new record's panel doesn't open in a stale "loading" state.

## Edge cases

- **Refs return empty.** Effect's empty-refs short-circuit clears state and returns; `titlesLoading` stays `false`. UI shows "No dependencies found." — unchanged.
- **Titles fetch is canceled by a record switch.** Reset effect bumps the request token and sets `titlesLoading=false`. The next render's titles fetch flips it back to `true`.
- **Titles fetch fails.** `.catch` sets `titlesLoading=false`. Groups render with id fallback. Better than indefinite spinner.
- **User collapses a group, then a new dep panel opens for a different record.** Each `DepGroup` instance has its own state, and the new record produces fresh `DepGroup`s, so the new panel opens fully expanded.

## Out of scope

- Persisting expand/collapse across record switches or across reloads.
- Pre-resolving titles in the refs API to avoid the second round-trip.
- Animations on the chevron or the collapse motion (use simple show/hide).

## Test plan

- Manual: click **Show Dependencies** for a record with multiple types, attrs configured. Verify no UUID flash — labels appear directly with the chosen attribute.
- Manual: click the chevron on a type group; dep buttons hide. Click again; they reappear. Display selector stays visible in both states.
- Manual: switch to another record; deps reset; new groups open expanded.
- Manual: simulate slow titles fetch (devtools throttling). Verify "Loading dependencies…" line shows during the wait, then groups appear when titles arrive.
- Manual: simulate titles fetch failure (block the route in devtools). Verify groups render with id fallback after a beat — no stuck loader.

No new unit tests; the underlying lib `resolveTitles` is already covered.
