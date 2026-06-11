# One-time update popup and what's-new popup

**Date:** 2026-06-11
**Status:** Approved

## Problem

PingHub already polls GitHub releases hourly and shows a slim `UpdateBanner`
strip when a newer version exists, but the banner is easy to miss and its
dismissal is per-session — it nags every restart yet never demands attention.
There is no notification the first time a new version is published, and no
confirmation of what changed after an upgrade.

## Behavior

Two popups, layered over the existing banner. At most one popup shows at a
time; both are one-time per browser (localStorage).

1. **New-version popup ("A")** — shows once per published version, when the
   hourly check finds `newerAvailable` and `latest.version` differs from the
   stored `pinghub.update.notified`. Contents: "PingHub v\<latest\> is
   available (you have v\<installed\>)", the release notes, and buttons:
   - **Upgrade & restart** (when `canUpdate`) — runs the existing upgrade
     phase machine; progress (downloading / restarting / reload) shows inside
     the modal, mirroring the banner's behavior today.
   - **View release** (when self-update unavailable, e.g. source-dev mode) —
     opens the GitHub release page.
   - **Later** — closes the popup.

   ANY close path (Later, View release, starting an upgrade) records
   `latest.version` in `pinghub.update.notified` — the popup never returns
   for that version. The slim banner keeps its current per-session behavior
   as the quiet ongoing reminder.

2. **What's-new popup ("C")** — shows once after the installed version
   changes: when `installed.version` differs from the stored
   `pinghub.version.lastSeen`. Contents: "What's new in v\<installed\>",
   the release notes when `installed.version === latest.version` (the normal
   post-upgrade case) or a "View releases" link otherwise, and a single
   **Got it** button that records `installed.version` in
   `pinghub.version.lastSeen`.

   First visit ever (key absent) initializes `lastSeen` silently — a fresh
   browser profile gets no what's-new popup.

**Precedence:** what's-new before new-version (the user just upgraded —
confirm what changed first; the new-version popup appears on a later render
once the what's-new is acknowledged). Both popups are suppressed while an
upgrade phase is active (downloading / waiting-for-restart / ready / error).

## Design

### Eligibility helper (pure, unit-tested)

`src/lib/update-notice.ts`:

```ts
export interface UpdateNoticeInput {
    installedVersion: string;
    latestVersion: string | null;
    newerAvailable: boolean;
    notifiedVersion: string | null;   // pinghub.update.notified
    lastSeenVersion: string | null;   // pinghub.version.lastSeen
}
export type UpdateNotice = "whats-new" | "new-version" | null;
export function updateNotice(input: UpdateNoticeInput): UpdateNotice;
```

Rules, in order:
1. `lastSeenVersion !== null && installedVersion !== lastSeenVersion` → `"whats-new"`.
2. `newerAvailable && latestVersion !== null && latestVersion !== notifiedVersion` → `"new-version"`.
3. Otherwise `null`.

(`lastSeenVersion === null` is the fresh-profile case — the component
initializes the key silently and never shows what's-new for it.)

### Release notes through the API

`system-update.ts` already parses the GitHub `releases/latest` response in
two places (`fetchLatestRelease` and the force-refresh path in the status
builder). `LatestRelease` gains `notes: string | null` — the release `body`,
server-truncated to 4000 chars (`null` when missing/empty). It flows through
`/api/system/version` automatically since the route returns the status object.

### Component

`UpdateBanner.tsx` stays the single owner of version status and the upgrade
phase machine (one poller, one source of truth) and additionally renders the
modal. New pieces inside the component:

- Hydrate `notifiedVersion` / `lastSeenVersion` from localStorage once
  (mirroring the existing sessionStorage dismissal effect); initialize
  `lastSeen` to `installed.version` silently when absent (written when the
  first status arrives).
- `const notice = phase === "idle" ? updateNotice({...}) : null;`
- Modal: fixed overlay (`fixed inset-0 bg-slate-900/40`), centered white
  card, title per notice type, notes in a `whitespace-pre-wrap` scrollable
  block (`max-h-64 overflow-y-auto`), buttons as specified. Plain text — no
  markdown rendering dependency.
- During upgrade phases started from the modal, the modal stays open showing
  the same phase texts the banner uses (downloading / restarting / reloading
  / error with dismiss).
- The banner renders exactly as today underneath; no behavior change.

The component file is renamed in spirit but keeps its name and mount point
(`src/app/layout.tsx:44`) — one component, banner + popups.

## Out of scope

- Markdown rendering of release notes.
- A by-tag GitHub API call for what's-new notes when installed ≠ latest
  (shows a releases link instead).
- Suppressing popups while report jobs run.
- Server-side or per-user notification state.

## Testing

- `src/lib/update-notice.test.ts` (vitest): fresh profile (lastSeen null) →
  null; new publish → "new-version"; already notified → null; post-upgrade
  (installed ≠ lastSeen) → "whats-new"; post-upgrade with an even newer
  release available → "whats-new" (precedence); up to date + seen → null.
- Existing suite, `tsc --noEmit`, eslint stay green.
- Manual smoke: clear the two keys → what's-new does NOT pop (fresh-profile
  init), new-version pops once and not after reload; after an upgrade the
  what's-new pops once with notes.
