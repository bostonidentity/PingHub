# Testing Gap Plan

Status legend:

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

## Current Baseline

- `[x]` Ran `npm test -- --coverage` on 2026-04-24.
- `[x]` Current result after graph-modal tests: 342 passing tests, 0 skipped tests, 53 test files.
- `[x]` Current coverage: 23.05% statements, 15.69% branches, 22.99% functions, 24.71% lines.
- `[x]` Noted coverage caveat: `vitest.config.ts` excludes `src/**/*.tsx`, so most UI workflow risk is not represented by coverage.

## Phase 1: Stabilize Existing Test Signal

- `[x]` Fix accidentally skipped semantic integration coverage.
  - Replace environment-folder-dependent tests with deterministic temp fixtures.
  - Ensure semantic integration tests run in every checkout and CI environment.
- `[x]` Remove avoidable `as any` usage in tests.
  - Target `tests/api/diff.test.ts`.
  - Target `tests/components/EnvCard.test.tsx`.
  - Target `tests/lib/compare.test.ts`.
- `[ ]` Add coverage expectations by area instead of one global threshold.
  - Keep global coverage informational for now.
  - Start tracking high-risk modules: compare API, promote-items, pull/push orchestration, journey graph.

## Phase 2: Cover Compare And Journey Diff Regressions

- `[x]` Add route tests for `src/app/api/compare/route.ts`.
  - `[x]` Local-local compare returns a report.
  - `[x]` Remote source/target calls pull orchestration and streams pull logs.
  - `[x]` `scopeSelections` filters files by parsed scope and does not leak item names across scopes.
  - `[x]` Journey dependency expansion adds subjourneys and scripts.
  - `[x]` Dry-run flips added/removed and swaps content/diff lines.
  - `[x]` Missing dependency warning appears only when `includeDeps` is false.
  - `[x]` ESV precheck runs only after dry-run report construction.
- `[x]` Add UI regression tests for `JourneyDiffGraphModal`.
  - `[x]` Mock `DiffGraphCanvas` to expose rendered node statuses.
  - `[x]` Open parent journey with `journeyTree`.
  - `[x]` Navigate into inner journey.
  - `[x]` Assert descended graph receives inner `nodeInfos` and shows modified node status.
- `[ ]` Expand `buildReport()` journey tree tests.
  - Parent `InnerTreeEvaluatorNode` should be marked `modifiedReason: "subjourney"` when child journey changed.
  - `ScriptedDecisionNode` should be marked `modifiedReason: "script"` when referenced script content changed.
  - PageNode child config changes should mark the child, not only the parent.

## Phase 3: Break Down And Test Promote Items

- `[ ]` Refactor `src/app/api/promote-items/route.ts`.
  - Extract pure helper modules from the route.
  - Candidate modules: `promotion-selection.ts`, `promotion-deps.ts`, `promotion-plan.ts`, `promotion-validation.ts`.
  - Keep the route handler focused on request parsing and response formatting.
- `[ ]` Add unit tests for extracted promote-item helpers.
  - Journey selected by name resolves to expected file paths.
  - Script selected by UUID and `name:` tag resolves correctly.
  - Dependencies are de-duped.
  - Missing subjourneys/scripts are reported predictably.
  - `includeDeps` changes the plan correctly.
  - Controlled and sandbox environment behavior is represented where applicable.
- `[ ]` Add route-level smoke tests for promote-items.
  - Valid request creates expected promotion task.
  - Invalid env/scope/item returns expected status.
  - Filesystem fixture simulates journey plus script dependencies.

## Phase 4: Cover Pull/Push Orchestration

- `[ ]` Test `src/lib/fr-config.ts`.
  - Filename-filter scopes batch items into `filenameFilter`.
  - Name-flag scopes run once per item with `--name`.
  - Benign errors classify as success.
  - Retry logic refreshes token on 401/403 only.
  - Heartbeat stream events are emitted during long operations.
- `[ ]` Test `src/lib/fr-config-dispatch.ts`.
  - Missing `TENANT_BASE_URL` returns handled failure.
  - Supported pull/push scopes dispatch to vendor functions.
  - Unsupported command/scope falls back to spawn.
  - `--direct-control` toggles mutable mode and resets it.
  - Script item normalization handles UUID, filename, and `name:` forms.
- `[ ]` Add API tests for pull/push routes.
  - Mock `spawnFrConfig`.
  - Assert streamed NDJSON passes through.
  - Assert op-history records success/failure.
  - Assert invalid body returns 400.

## Phase 5: Cover Promotion And DCC

- `[ ]` Test `src/lib/tenant-control.ts`.
  - Open session success/failure.
  - Apply session success/failure.
  - Restart/status edge cases.
  - Proper headers/body sent to AIC.
- `[ ]` Test `api/promote/route.ts` and `api/dcc/route.ts`.
  - Promotion command validation.
  - Controlled environment path uses DCC phases.
  - Error stream is surfaced.
  - Unlock/rollback paths are safe and logged.
- `[ ]` Add UI tests for `PromoteWorkflow` and `PromoteExecution`.
  - Step gating: dry-run required before promote.
  - Production/controlled confirmations.
  - Failed phase shows retry/rollback affordance.
  - `includeDeps` toggle changes submitted payload.

## Phase 6: Cover Analyze, Search, Logs

- `[ ]` Unit test `src/lib/analyze/esv-orphans.ts`.
  - Finds `&{esv}` placeholders.
  - Finds `systemEnv.` lookups.
  - Ignores defined variables/secrets.
  - Handles malformed JSON/script files gracefully.
- `[ ]` Add API tests for analyze routes.
  - `script-usage`, `endpoint-usage`, `journey-usage`.
  - Cross-realm path handling.
  - Missing env/file returns expected status.
- `[ ]` Add API tests for search/log routes.
  - Search matches files, scripts, journeys.
  - Search respects scope/env.
  - Logs source discovery handles missing dirs.
  - Log query handles malformed log files.

## Phase 7: Add Focused UI Workflow Tests

- `[ ]` Add config browser workflow tests.
  - Environment switch loads config tree.
  - Journey graph opens selected journey.
  - Script overlay loads script by node.
  - Missing file displays a safe error.
- `[ ]` Add push page workflow tests.
  - Audit loads changed items.
  - Selecting files builds expected push plan.
  - Dangerous confirmation appears for production/controlled target.
  - Push stream updates log viewer.
- `[ ]` Add environment manager workflow tests.
  - Create/edit/delete environment.
  - `.env` serialization preserves unknown keys/comments.
  - Connection test result is displayed.
  - Reorder persists order.
- `[ ]` Add data browser workflow tests.
  - Snapshot list loads.
  - Record table filters/searches.
  - Detail pane renders selected record.
  - Export link/API is wired.

## Phase 8: Tooling And Guardrails

- `[~]` Fix lint scope.
  - Current `npm run lint` scans tenant config scripts and vendored JS, producing thousands of unrelated errors.
  - `[x]` Add ignores for `environments/**` and vendored upstream `src/vendor/fr-config-manager/**`.
  - `[~]` Resolve remaining app-source lint failures.
    - After narrowing scope, `npm run lint` reports 42 errors and 75 warnings.
    - Remaining errors are real app/test source issues, mostly React Compiler rules around setState-in-effect/ref access during render plus one `no-explicit-any`.
  - Goal: `npm run lint` is meaningful in CI.
- `[ ]` Split test commands.
  - `npm test`: all unit/integration tests.
  - `npm run test:coverage`: coverage report.
  - `npm run test:api`: API route tests.
  - `npm run test:ui`: jsdom component tests.
- `[ ]` Add shared test fixture builders.
  - Temp config dirs.
  - Journeys.
  - Scripts.
  - Env files.
  - Op-history.
  - Streamed NDJSON.
- `[ ]` Add CI thresholds by folder after coverage improves.
  - Keep `lib/semantic-compare`, `lib/data`, and `lib/rcs` high.
  - Add new thresholds for `api/compare`, `api/promote-items`, and `lib/fr-config`.

## Suggested Execution Order

- `[x]` 1. Fix skipped integration tests.
- `[~]` 2. Fix lint scope.
- `[x]` 3. Add compare route tests.
- `[x]` 4. Add `JourneyDiffGraphModal` navigation regression test.
- `[ ]` 5. Refactor and test `promote-items`.
- `[ ]` 6. Add pull/push orchestration tests.
- `[ ]` 7. Add promotion/DCC tests.
- `[ ]` 8. Fill analyze/search/logs.
- `[ ]` 9. Add broader UI workflow tests.
