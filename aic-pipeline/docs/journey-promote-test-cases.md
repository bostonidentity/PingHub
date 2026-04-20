# Journey Promotion Test Cases

## 1. Basic Promotion (Happy Path)

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 1.1 | Single journey, no dependencies | Promote a simple journey with no sub-journeys or scripts | Journey appears on target with correct structure |
| 1.2 | Multiple journeys at once | Select 2+ journeys in the same promotion task | All selected journeys are promoted to target |
| 1.3 | Full scope (no item filter) | Promote the entire `journeys` scope without selecting specific items | All journeys in the scope are pushed to target |

## 2. Dependency Resolution (`includeDeps=true`)

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 2.1 | Journey with script references | Promote a journey whose nodes contain `ScriptedDecisionNode` with a `script` UUID, with `includeDeps` enabled | Referenced scripts are auto-discovered and included in the promotion |
| 2.2 | Journey with sub-journeys | Promote a journey containing an `InnerTreeEvaluatorNode` referencing another journey via the `tree` field | Sub-journey is auto-included in the promotion |
| 2.3 | Transitive dependencies | Journey A references sub-journey B, which references sub-journey C | Sub-journey C is discovered recursively and included |
| 2.4 | Shared dependencies | Two selected journeys reference the same script | Script is included once with no duplicates or conflicts |
| 2.5 | `includeDeps=false` | Promote a journey that has script/sub-journey deps but with the flag off | Only the journey itself is pushed; dependencies are NOT included |

## 3. Script UUID Remapping

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 3.1 | Script UUID differs on target | Source script has UUID `aaa`, target has UUID `bbb` for the same script name | Promoted journey nodes are updated from `aaa` to `bbb` |
| 3.2 | Script exists on source but not on target | Promote a journey referencing a script that does not exist on target | Graceful handling: warning is logged, promotion continues |
| 3.3 | Multiple scripts in one journey | Journey references 3+ different scripts | All script UUIDs are remapped correctly in the node files |

## 4. Dry Run / Comparison Phase

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 4.1 | No diff (source = target) | Promote a journey that already exists identically on target | Diff phase shows no changes |
| 4.2 | New journey (not on target) | Promote a journey that does not exist on target | Diff shows it as an addition |
| 4.3 | Modified journey | Journey exists on both environments but differs | Diff correctly highlights the changes |

## 5. Edge Cases

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 5.1 | Journey name with special characters | Promote a journey whose directory name contains spaces, dashes, or unicode characters | Promotion completes without path-related errors |
| 5.2 | Empty journey (no nodes) | Promote a journey with only the top-level JSON and an empty `nodes/` directory | Promotion completes without errors |
| 5.3 | Circular sub-journey reference | Journey A references B, B references A; promote with `includeDeps` | The `visited` set prevents infinite recursion; promotion completes |
| 5.4 | Large journey | Promote a journey with 50+ nodes | Promotion completes with correct results and acceptable performance |

## 6. Direct Control Flag

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 6.1 | `directControl=true` | Promote with the direct control option enabled | `--direct-control` flag is passed to `fr-config-push`, targeting `/mutable` endpoints |
| 6.2 | `directControl=false` | Promote with the direct control option disabled | Standard push without the `--direct-control` flag |

## 7. Error and Recovery

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 7.1 | Source environment unreachable | Attempt promotion when source environment is down or misconfigured | Meaningful error message appears in the SSE log stream |
| 7.2 | Target environment unreachable | Attempt promotion when target environment is down or misconfigured | Push fails gracefully; pull phase is skipped |
| 7.3 | Partial failure | Push succeeds for journeys but fails for a dependent script scope | Error is reported clearly; target pull phase is skipped |
| 7.4 | Temp directory cleanup | Observe temp directory after both successful and failed promotions | Temp directory is removed in all cases |

## 8. Post-Promotion Verification (Phase 4)

| # | Test Case | Steps | Expected Result |
|---|-----------|-------|-----------------|
| 8.1 | Local file sync after push | Complete a successful promotion and inspect local files | Target environment's local files are re-pulled and updated |
| 8.2 | Re-compare matches | After push + pull, run the verification comparison | Source and target are in sync for the promoted items |
