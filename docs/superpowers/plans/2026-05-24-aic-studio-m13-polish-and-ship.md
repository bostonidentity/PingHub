# AIC Studio M13 — Polish & v1.0 Ship Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Final milestone before v1.0 GA. Tightens everything: comprehensive test sweep, real README/marketplace listing, polished icons, walkthroughs/welcome experience, error message review, real publisher account + first marketplace publish (both stable + insiders channels). End-state: `bostonidentity.aic-studio` v1.0.0 is live on VS Code Marketplace and Open VSX.

**Architecture:** No new code surfaces. Pure polish + ops:
- Walkthrough JSON for first-run onboarding
- Real icon (replace M1 placeholder SVG)
- README rewrite with marketplace-friendly content (screenshots, gif, install)
- Smoke test script for pre-publish validation
- CI: enable insiders publish workflow (currently disabled via `if: false`)
- Manual publisher account setup + first publish
- v1.0.0 release tag + git annotated tag

**Branch:** `aic-studio/m13` branched from `aic-studio/m11-m12` (the final feature branch).

---

## File Structure

```
aic-studio/
  media/
    icon.svg                                    REPLACE — real designed icon
    icon.png                                    REPLACE — 128x128 from real svg
    icon-dark.svg                               NEW — dark-theme variant
    walkthrough/                                NEW — screenshots referenced by walkthrough
      add-env.png
      pull.png
      promote.png
  walkthroughs/
    getting-started.md                          NEW — walkthrough content
  README.md                                     REWRITE — full marketplace listing
  CHANGELOG.md                                  MODIFY — add M13 + v1.0.0 release section
  package.json                                  MODIFY — add walkthrough contribution; bump version to 1.0.0
  scripts/
    smoke.mjs                                   NEW — manual pre-publish smoke script
docs/legacy/
  aic-pipeline-changelog.md                     NEW — archive of legacy changelog
.github/workflows/
  aic-studio-insiders.yml                       MODIFY — remove `if: false` (enable)
  aic-studio-release.yml                        NEW — tagged release publish to marketplace + OVSX
```

---

## Pre-Task Setup

```bash
git worktree add /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m13 -b aic-studio/m13 aic-studio/m11-m12
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m13/aic-studio
npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
```

---

## Task 1: Real icon set

**Files:** `aic-studio/media/icon.svg`, `aic-studio/media/icon-dark.svg`, `aic-studio/media/icon.png`

Replace the M1 placeholder SVG with a designed icon. Use a vector tool (Figma / Sketch / Inkscape) or commission one. Generate light + dark variants. Convert to 128x128 PNG for the marketplace.

If no designed icon is ready: keep the M1 SVG as-is but generate a more polished PNG using a 256x256 source SVG, then downsample to 128x128 with sips/convert for crispness.

Commit `chore(aic-studio): polished icon set (light + dark)`.

---

## Task 2: README rewrite

**Files:** `aic-studio/README.md`

Full marketplace listing. Structure:

```markdown
# AIC Studio for Ping Advanced Identity Cloud

Manage Ping AIC tenant configurations from VS Code — pull, edit, diff, promote, and monitor envs without leaving your editor.

![hero screenshot or GIF](media/walkthrough/hero.gif)

## Features

- 🌍 Per-env browsing (journeys, federation, scripts) as a sidebar TreeView
- ⬇️ Pull entire env snapshots via OAuth client_credentials
- 🔁 Push individual journeys or group them into promotion tasks
- 🔍 Built-in diff editor for env-to-env or revision-to-revision compare
- 📊 Health monitoring (TLS expiry, server ping, RCS) with dashboard
- 📜 Log query webview with saved searches
- 🔗 Find usage — cross-reference scripts, federation, journeys
- 🛡️ Credentials stored in OS keychain via VS Code SecretStorage

## Getting Started

[3-5 step walkthrough screenshot strip]

1. Install from VS Code Marketplace
2. Click the PingHub icon in the activity bar
3. Run **AIC Studio: Add environment…** and enter your tenant URL + service account
4. Run **AIC Studio: Pull from environment** — see journeys appear in the sidebar
5. Click a journey to view; right-click to push / compare / find usage

## Walkthrough

In VS Code, run **Welcome: Open Walkthrough** → **Getting Started with AIC Studio**.

## Configuration

[Table of settings]

## Privacy & Security

- All credentials stored in VS Code SecretStorage (OS keychain)
- All data stored locally under your VS Code globalStorage
- No telemetry sent to PingHub or Boston Identity
- Each AIC operation logs to the "AIC Studio" OutputChannel

## Support

- File issues: https://github.com/bostonidentity/PingHub/issues
- Discussions: https://github.com/bostonidentity/PingHub/discussions

## License

Apache 2.0 — see [LICENSE](./LICENSE)
```

Capture screenshots for `media/walkthrough/` as part of the manual workflow before committing.

Commit `docs(aic-studio): rewrite README for marketplace listing`.

---

## Task 3: Walkthrough contribution

**Files:** `aic-studio/walkthroughs/getting-started.md`, `aic-studio/package.json`

Add to `contributes`:

```json
    "walkthroughs": [
      {
        "id": "aic-studio.gettingStarted",
        "title": "Getting Started with AIC Studio",
        "description": "Set up your first AIC environment and pull configs in under 2 minutes.",
        "steps": [
          {
            "id": "addEnv",
            "title": "Add an AIC environment",
            "description": "Configure your tenant URL and service-account credentials. Credentials are stored in your OS keychain via VS Code SecretStorage.",
            "media": { "image": "media/walkthrough/add-env.png", "altText": "Add environment dialog" },
            "completionEvents": ["onCommand:aic-studio.env.add"]
          },
          {
            "id": "pull",
            "title": "Pull from your environment",
            "description": "Fetches all journeys and federation configs.",
            "media": { "image": "media/walkthrough/pull.png", "altText": "Pull progress" },
            "completionEvents": ["onCommand:aic-studio.sync.pull"]
          },
          {
            "id": "promote",
            "title": "Promote to another env",
            "description": "Add journeys to a promotion task and push them as a batch.",
            "media": { "image": "media/walkthrough/promote.png", "altText": "Promote workflow" },
            "completionEvents": ["onCommand:aic-studio.promote.runTask"]
          }
        ]
      }
    ]
```

Commit `feat(aic-studio): getting-started walkthrough`.

---

## Task 4: Error message review

Audit every `showErrorMessage` / `showWarningMessage` call across the codebase. Ensure messages are:
- Actionable (tell user what to do)
- Concise (one sentence + optional detail)
- Include the env name where applicable
- Don't leak secrets

For each error site, add a "Show OutputChannel" action button where helpful:

```typescript
const sel = await vscode.window.showErrorMessage(msg, "Show output");
if (sel === "Show output") {
  vscode.commands.executeCommand("workbench.action.output.show");
}
```

Commit `chore(aic-studio): error message audit + Show-output actions`.

---

## Task 5: Smoke test script

**File:** `aic-studio/scripts/smoke.mjs`

Manual pre-publish script. Spawns VS Code via `@vscode/test-electron` programmatically, installs the built VSIX, walks through:

```javascript
import { runTests } from "@vscode/test-electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await runTests({
  extensionDevelopmentPath: join(__dirname, ".."),
  extensionTestsPath: join(__dirname, "../out/tests/smoke/index.js"),
  launchArgs: ["--disable-extensions"]
});
```

Plus a `tests/smoke/` directory with sequential tests that exercise real AIC sandbox endpoints (using env-injected creds from `SANDBOX_TENANT_URL`, `SANDBOX_CLIENT_ID`, `SANDBOX_CLIENT_SECRET`). Document in README that smoke requires these env vars.

Commit `chore(aic-studio): smoke test script for pre-publish`.

---

## Task 6: Bump version to 1.0.0 + CHANGELOG release entry

**Files:** `aic-studio/package.json`, `aic-studio/CHANGELOG.md`

- Change `"version": "0.1.0"` → `"version": "1.0.0"` in package.json.
- In CHANGELOG, move all `[Unreleased]` sections into a new `## [1.0.0] - YYYY-MM-DD` section. Leave `[Unreleased]` empty above it.

Commit `chore(release): v1.0.0`.

---

## Task 7: Enable insiders publish workflow

**File:** `.github/workflows/aic-studio-insiders.yml`

Remove the line `if: false  # ← remove this line when ready to publish` from the build job.

Add to README: a note about insiders ID = `bostonidentity.aic-studio-insiders`.

Commit `ci(aic-studio): enable insiders publish on main push`.

---

## Task 8: Release workflow

**File:** `.github/workflows/aic-studio-release.yml`

Trigger on `v*` tag push. Same matrix as insiders but publishes the stable extension ID:

```yaml
name: aic-studio release publish

on:
  push:
    tags:
      - "v*"

defaults:
  run:
    working-directory: aic-studio

jobs:
  publish:
    strategy:
      fail-fast: false
      matrix:
        target:
          - { runs: ubuntu-latest, vsce: linux-x64 }
          - { runs: windows-latest, vsce: win32-x64 }
          - { runs: macos-14, vsce: darwin-arm64 }
          - { runs: macos-13, vsce: darwin-x64 }
    runs-on: ${{ matrix.target.runs }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
          cache-dependency-path: aic-studio/package-lock.json
      - run: npm ci
      - run: npx electron-rebuild --force -m node_modules/better-sqlite3
        continue-on-error: true
      - run: npm run build
      - name: Package
        run: npx vsce package --target ${{ matrix.target.vsce }}
      - name: Publish to VS Code Marketplace
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
        run: npx vsce publish --packagePath aic-studio-*.vsix
      - name: Publish to Open VSX
        env:
          OVSX_PAT: ${{ secrets.OVSX_PAT }}
        run: npx ovsx publish aic-studio-*.vsix
      - name: Upload as GitHub Release artifact
        uses: softprops/action-gh-release@v2
        with:
          files: aic-studio/aic-studio-*.vsix
```

Commit `ci(aic-studio): tagged-release publish to Marketplace + OVSX + GH Release`.

---

## Task 9: Publisher accounts (MANUAL — out-of-band)

Outside-of-code steps for the human user:

1. **VS Code Marketplace publisher.** Create publisher `bostonidentity` on https://marketplace.visualstudio.com/manage. Generate a Personal Access Token (PAT) with Marketplace > Manage scope.
2. **Open VSX publisher.** Create publisher `bostonidentity` on https://open-vsx.org. Generate access token.
3. **GitHub secrets.** Add `VSCE_PAT` and `OVSX_PAT` to the PingHub repo settings.
4. **GitHub Actions enabled.** Ensure aic-studio workflows have permission to read/write contents (for GH Releases).
5. **Marketplace asset prep.** Upload the 128×128 PNG icon + README screenshots to the listing.

No commit for this task — track completion via the M13 CHANGELOG / project board.

---

## Task 10: First insiders publish (CI-driven)

After Task 9, when a commit lands on `main`, the insiders workflow fires and publishes `bostonidentity.aic-studio-insiders`.

Verify by:
- Watching the GitHub Actions run to completion
- Installing in VS Code: search "AIC Studio Insiders" or `code --install-extension bostonidentity.aic-studio-insiders`
- Running through the walkthrough on a real sandbox

No commit. Document the run number in CHANGELOG once successful.

---

## Task 11: Sandbox smoke test

Manual: with insiders installed in a clean VS Code profile, walk through:
1. Add env (sandbox tenant)
2. Pull
3. Browse journeys in sidebar
4. Compare two envs
5. Add journey to promotion task
6. Run promotion task (with `stage` as target)
7. Confirm op_history shows the operations
8. Open dashboard — see env summary
9. Search for a known journey via QuickPick

If any step fails: file an issue with `aic-studio:v1-blocker` label. Fix → repeat smoke. Do NOT proceed to v1.0 tag if any blocker open.

---

## Task 12: Tag v1.0.0 + release

Once smoke passes:

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m13
git tag -a v1.0.0 -m "AIC Studio v1.0.0 — first marketplace release"
```

Push the tag (this triggers the release workflow):

```bash
git push origin v1.0.0
```

(Confirm with user first — pushing tags requires explicit ask per standing instruction.)

Watch CI; verify marketplace listings update. Add the marketplace + OVSX URLs to README + PingHub root README.

Commit `docs(aic-studio): v1.0.0 release notes` with marketplace URLs added.

---

## Task 13: Update legacy aic-pipeline with deprecation banner

Web app (still alive during the deprecation window per spec §7) gets a sunset banner:

- Edit `aic-pipeline/src/components/NavBar.tsx` to add an info banner at the top: "AIC Pipeline is being replaced by the AIC Studio VS Code extension. Install: [marketplace URL]. This web app will be archived on YYYY-MM-DD."
- Update `aic-pipeline/README.md` similarly.
- Bump aic-pipeline version (e.g., 0.2.8) with this banner.

This task runs on the `development` branch (not in the worktree). User-driven.

Commit `chore(aic-pipeline): add sunset banner pointing to AIC Studio`.

---

## Task 14: M13 acceptance gate

```bash
cd /Users/ledeng/projects/deloitte/ky/PingHub/.worktrees/aic-studio-m13/aic-studio
rm -rf node_modules out coverage && npm ci
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm run typecheck && npm run lint
npm rebuild better-sqlite3 && npm test -- --run
npm run build
npx vsce package --target darwin-arm64 --pre-release
ls aic-studio-*.vsix
rm aic-studio-*.vsix
npx electron-rebuild --force -m node_modules/better-sqlite3 -v 39.8.8 -w better-sqlite3
npm run test:integration
```

Expected: all green. NO COMMIT — verification only.

---

## Self-Review

**Spec coverage:** §5 distribution (insiders + release workflows) ✓. §7 cutover phases — Phase 3 (v1.0 ship) is this milestone; Phase 4 (deprecation window) starts on tag day; Phase 5 (web app removal) deferred to a separate cleanup PR after the 60-day window.

**Type consistency:** N/A (no new code surfaces).

**Notes:**
- Tasks 9, 10, 11, 12, 13 require human action (publisher accounts, smoke test, tag push, web-app banner). The subagent executing this plan should pause for the user to perform them and confirm completion before moving on.
- If smoke uncovers blockers: do NOT tag v1.0.0. Fix, re-publish insiders, re-smoke.
- Tag pushes ARE explicit destructive ops affecting shared state (Marketplace + OVSX + GH Release). Always confirm with user before `git push origin v1.0.0`.

Plan ready for execution. This is the final v1.0 milestone — after Task 12 succeeds, the extension is live and the cutover deprecation window begins.
