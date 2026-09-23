# Evidence — D1g (compatibility and program gate)

| | |
|---|---|
| Packet | D1g · controller · Phase D |
| Requirements | AC-18 (compare), program gate |
| Candidate | `codex/runner-v2-agent-capability` at `e3bf2d28` (code); publication commit after it |
| Node | `C:\Program Files\nodejs\node.exe` v24.18.0 |
| State | **ACCEPTED** |

## 1. Source-to-delivery reconciliation

| Step | Outcome |
|---|---|
| Independent reconciliation at `c81f632a` (`D1g-reconciliation.md`) | NOT RECONCILED — one BLOCKING cross-packet hole (handoff during an open context-recording decision); one MINOR accepted (symlink refused at commit, not at append — plan A4/A5 design) |
| Repair `dadc4c4c` | reducer refuses `run.completed`, `project.handoff_requested`, `project.handoff_selected` while a recording note is unresolved; prove-red recorded in `B2.md` |
| Owner-requested prompt review (`prompt-review.md`) | fix-now set applied: `11ea357c` (H1, H2, H4, H5; `PF1.md`), `e3bf2d28` (H3, M2, M4–M6; `PF2.md`); the rest deferred to P6.6 T10 (OA-18 / EP52) |
| Independent re-check of `c81f632a..e3bf2d28` (`D1g-recheck.md`) | **RECONCILED — READY FOR FINAL GATE**, no new finding |

## 2. Final gate (run once, on the reconciled candidate `e3bf2d28`)

| Gate | Result |
|---|---|
| AC-18 replay (`replay-compatibility.test.ts`, inside the full suite) | pass — the A0 fixture replays to the identical projection |
| `npm run test:runner-v2` | **3203 tests, 3198 pass, 0 fail, 0 cancelled, 5 skipped**; 18 chained scripts PASS; exit 0; 2239 s. Skips are the baseline host gates (2 × Darwin path alias, 2 × POSIX session/fence, 1 × host-gated output-factory fixture). Log `d1g-full-suite.log` |
| `tsc -p runner-v2/tsconfig.json --noEmit` | exit 0 |
| `tsc --noEmit` | exit 0 |
| `npx eslint .` | exit 0 — 0 errors, 14 warnings: the 13 pre-existing plus one in the evidence file `A0-capture.mts` (not product code) |
| `npm run build` | exit 0; static export succeeded |
| Publication commit | refreshed `public/aiboard-runner-v2.zip`, `public/aiboard-workbench-runner.zip` |

## 3. Verdict

All applicable mandatory requirements of the SOURCE (revision 4) — AC-1..AC-10, AC-17, AC-18, AC-24, AC-25 — have accepted packet evidence, the cross-packet reconciliation is clean, and the final gates pass on the final candidate.

**PLAN VERIFIED COMPLETE — ALL APPLICABLE MANDATORY REQUIREMENTS AND FINAL GATES PASSED**

This does not claim the absence of every possible defect. Real-world timing/load behaviour is P7's scope (SOURCE §3.1).
