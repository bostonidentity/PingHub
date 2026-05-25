# semantic-compare

Path-based byte diff is insufficient across ForgeRock environments: UUIDs
(journeys, nodes, scripts) differ between sandbox and controlled tenants
even when the logical content is identical. This module computes
**semantic equality** by canonicalizing env-local identifiers to stable
keys before comparing.

## Identity model

| Resource | Stable identity |
|----------|-----------------|
| Journey  | directory name |
| Node     | `${nodeType}:${displayName}` + `#N` disambiguator |
| Script   | `(context, name)` tuple |

## Canonicalization

1. `buildScriptMap(configDir)` → `uuid → "${context}/${name}"`
2. Per journey: `buildNodeKeyMap(tree)` → `uuid → stableKey` via deterministic
   traversal from `entryNodeId`, outcomes sorted alphabetically, collisions
   disambiguated.
3. `canonicalizeNode` rewrites `script` UUIDs, `PageNode.nodes[]._id`,
   strips `_id`/`_rev`/timestamps, sorts keys.
4. `canonicalizeJourney` rewrites wiring, drops coordinates, preserves
   `staticNodes` key set (not coords).

## Equality

`journeysEqual(a, b, ctx)` returns `{ equal, reasons[] }` where reasons is
a discriminated union covering header, node-set, node-settings,
script-missing, script-body, script-meta, subjourney-missing,
subjourney-diff. Recursion into inner journeys is cycle-guarded via
`ctx.visited`.

## Entry points

- `loadCanonicalEnv(configDir)` → `{ scripts, journeys }` for one env.
- `journeysEqual(a, b, ctx)` for single-pair comparison.
- `loadSemanticJourneys(src, tgt, scopes)` adapter used by `buildReport`
  to attach `semanticJourneys` to the compare response (lives in
  `src/lib/semantic-compare-adapter.ts`).

## Testing

Unit tests live in `tests/lib/semantic-compare/` and cover:
- JSON primitives (sort, strip, esv normalize)
- Script canonicalization + equality
- Node ref registry
- Node stable-key map (collisions, disconnected nodes, missing entryNodeId)
- Node canonicalization (script rewrite, PageNode child rewrite)
- Journey canonicalization (header strip, wiring rewrite, coord drop)
- Journey equality (all 8 reason kinds, recursion, cycle guard)
- Loader (both realm layouts, malformed JSON skipping)
- Integration (real ide + ide3 fixtures)
