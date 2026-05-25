# Pull: Pruning Locally-Deleted-Remotely Files

By default, the `fr-config-pull` / `frodo` / `iga-api` runners only **write** remote state to disk — they never delete local files. That means if a config object is deleted remotely (e.g. a journey is removed in the source tenant), the stale file lingers on disk after a pull and will be re-pushed to downstream environments unless cleaned up manually.

This document describes the prune behavior layered on top of the pull runners by `POST /api/pull`.

---

## Goal

Make a pull a true mirror of the remote tenant for the selected scopes — additions, modifications, **and** deletions all land locally.

## Safety model

Pruning is safe because the pull route already performs a **pre-pull auto-commit** of any uncommitted local changes (`src/app/api/pull/route.ts`). Anything wiped by the prune step is recoverable via `git checkout` from the commit that was just made, so no local work can be lost.

If the pre-pull commit fails, the pull (and therefore the prune) is aborted — same as today.

## Algorithm

After a successful pre-pull commit, and before spawning any pull runner:

1. Resolve `CONFIG_DIR` to an absolute path for the target environment.
2. For each scope in the effective selection (`scopes`, or all `cliSupported` scopes when empty):
   - Look the scope up in `SCOPE_DIR` / `REALM_SCOPE_SUBDIR` (`src/lib/git.ts`).
   - **Global scope**: delete `<CONFIG_DIR>/<SCOPE_DIR[scope]>` if it exists.
   - **Realm scope**: for each `<CONFIG_DIR>/realms/<realm>/`, delete `<realm>/<REALM_SCOPE_SUBDIR[scope]>` if it exists.
   - Scopes not in either map are skipped (no prune).
3. Emit a `git`-style log event (`action: "pre-pull-prune"`) for each directory that was deleted, so the log viewer shows exactly what was wiped.
4. Hand off to the normal pull runners, which repopulate the now-empty scope directories with fresh remote state.
5. Post-pull `analyzeChanges` runs against the dirty working tree, so remotely-deleted files surface naturally as `deleted` in the per-scope breakdown, and the post-pull auto-commit records the full diff.

## Guards

- **Item-level filtering**: if a selection carries item-level filters (e.g. a single journey by name, or a filename filter on `scripts`), the whole scope directory must **not** be pruned — the pull won't repopulate the siblings, so a naive prune would wrongly delete them. The current `POST /api/pull` route only accepts full-scope selections, so this is a non-issue today, but the guard is documented here for any future extension that threads `scopeSelections` through.
- **Unknown scopes**: any scope without an entry in `SCOPE_DIR` / `REALM_SCOPE_SUBDIR` is skipped entirely. Directories outside the known scope maps (custom folders users keep inside `CONFIG_DIR`) are never touched.

## Non-goals

- Pruning the whole `CONFIG_DIR` wholesale — too blunt; would nuke unknown/custom subtrees.
- Handling deletions for item-filtered pulls — would require per-scope knowledge of each item's file layout. Out of scope.
- Changing the behavior of the underlying `fr-config-pull` / `frodo` / `iga-api` runners themselves.

## Related

- `src/app/api/pull/route.ts` — pull route entrypoint where pruning is wired in.
- `src/lib/git.ts` — `SCOPE_DIR`, `REALM_SCOPE_SUBDIR`, and the `pruneScopeDirs` helper.
- `src/lib/fr-config.ts` — `getConfigDir` resolves `CONFIG_DIR` to an absolute path per environment.
