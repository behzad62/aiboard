# Task-cohesion real-model evaluation — 2026-10-26

## Scope and status
This is a small real-model **prompt-level** evaluation using the current shared `TASK_COHESION_GUIDELINE` and `TASK_COHESION_REVIEW_INSTRUCTIONS` loaded directly from `runner-v2/src/task-cohesion.ts`. Claude Sonnet was invoked by the local Claude CLI, without repository tools. It is **not** an end-to-end product Native Runner V2 build or a statistically representative performance measurement. No production build, scheduler state, or running service was modified.

Isolated test scripts, per-call JSON outputs and logs: `D:\repos\aiboard-task-cohesion-eval-20261026\`, especially `results\`. The existing AIBoard working tree was not used as a test project.

## Experiments
- **Architect A/B:** two realistic software requests, each generated once with baseline neutral task instructions and once with the shared cohesion rule. Same model and output schema; uncontrolled model variation remains.
- **Reviewer seeded challenges:** intentionally fragmented friend-request work; unrelated bundled work; legitimate standalone small fix; legitimate independently testable migration/API. Reviewed under the exact shared cohesion instructions.
- **Reviewer natural plans:** each of the four generated plans reviewed under the cohesion instructions.
- **Calls:** 12 model calls (4 Architect, 4 seeded Reviewer, 4 real-plan Reviewer); recorded model-cost estimates total **USD 0.36082**, excluding the separate connectivity probe. Estimates are not invoices.

## Results
| Test | Baseline | Cohesion-guided | Interpretation |
|---|---|---|---|
| Friends, presence and table invitations | 8 tasks | 8 tasks | No observed task-count reduction; both mostly used recognizable backend/UI slices |
| Payment webhook + entitlement admin + unrelated chart bug | 7 tasks | 7 tasks | Both isolated the unrelated chart fix; both left some review/integration granularity issues |
| Seeded fragmented plan | — | `undersized_task` blocking | Correctly proposed merging endpoint and its tests; cautioned that an independently validated migration could remain |
| Seeded incoherent plan | — | `incoherent_task` blocking | Correctly separated friendship, chart bug, CSS migration and push notifications |
| Seeded legitimate small fix | — | Approved, 0 findings | No artificial over-splitting |
| Seeded standalone migration then API | — | Approved, 0 findings | No automatic objection to a useful foundation milestone |

**Seeded outcomes:** 4/4 matched the expected approve/revise direction in this small fixed set. This is only evidence of obvious-case recognition, not a general accuracy rate.

## Review of the four natural Architect plans
- **Friends baseline:** approved with a testability advisory about the behavior when crossing friend requests are exchanged.
- **Friends guided:** requested revision for a purported missing `T7 -> T3` dependency. **Likely false positive:** `T7` invites a friend, receives and accepts/declines invitations; its criteria do not require online-presence data from `T3`. The reviewer additionally invented a “show online friends first” criterion absent from the request. Treat this blocking finding as ungrounded unless a further UI requirement establishes it.
- **Payments baseline:** requested revision including a potentially useful advisory merge of admin API + UI, and moving webhook docs to their owning deliverable.
- **Payments guided:** requested revision to remove the unrelated chart-fix `T6` dependency from webhook integration `T7`. This is a plausible correctness improvement, since unrelated work should not gate that integration task.

## Assessment
**Result: partially promising, not yet proven.** Guidance and reviews have the intended semantics, and seeded reviewer tests were correct; the guided Architect plans were not demonstrably more coherent in these two examples. The Reviewer can manufacture or exaggerate a dependency while trying to improve cohesion. Task counts alone are not a quality metric; do not automatically merge frontend and backend when they each have independent interfaces, tests, and acceptance boundaries.

## Proposed targeted follow-up
1. **Improve reviewer grounding:** a `missing_dependency` finding must cite an actual consumed API/file/behavior required by the *task's own* acceptance criteria. Shared feature area or nice-to-have UI sorting is insufficient for blocking.
2. **Discourage verification-only tasks with no enduring deliverable:** put targeted tests with their owning behavior, retain separate integration-test/documentation tasks only when they deliver an independently accepted artifact. Leave final full-suite execution to the build-level verification gate.
3. **Re-test with multiple seeds/models and full native plan contracts.** Do not claim the feature improves live deployment until isolated plan-only runs via Native Runner V2 and actual model-generated drafts and correction passes are compared.
4. **Track downstream effects:** number of acceptance-ready changesets, correction cycles, reviewer false positives, integration conflicts, and measured review usage. Do not optimize for task count.

No code-behavior changes were made as part of this evaluation.

