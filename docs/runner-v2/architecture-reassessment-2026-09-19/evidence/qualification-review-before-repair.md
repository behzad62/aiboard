## Review identity

- **Snapshot:** `C:/Users/b_a_s/.codex/tmp/runner-v2-qualification-20260920/review-snapshot/`
- **Manifest:** 22 paths; workflow SHA `777EB42D…3657`; harness SHA `B4492C32…9867`
- **Architecture baseline:** HEAD `2ffb8054` (accepted; not reopened)
- **Scope:** frozen candidate only; live repo used for unchanged APIs / prior coverage comparison

---

## Blocker

**1. Failure diagnostics never capture fixture state / SQLite / sidecars into the upload tree**
- **Files:** `runner-v2/test/support/qualification-harness.ts` ~101–128, 216–247, 269–284; callers never pass `fixtureRoots` (only empty default); scenarios e.g. `scenarios/windows-portable.ts` ~58–63, ~98–100, `scenarios/recovery.ts` ~87–90, `scenarios/cli-config.ts` finally `rmSync`
- **Failure path:** scenario fails → `finally`/`rmSync` deletes tmp fixture (or root stays only under OS tmpdir) → child/`runIsolatedScenario` writes summary+stdout/stderr only → artifact upload of `qualification-evidence` has path pointers or empty fixture trees, not `state.json` / `*.sqlite*` / output/ack. Investigation requires a rerun.
- **Kind:** missing gate/evidence (harness), not a product defect
- **Repair:** register fixture roots; on any failure/timeout **copy** selected durable files into `evidenceRoot/diagnostics/...` **before** cleanup/delete; ensure timeout path also captures.

**2. Alias / config-trust scenarios can green-pass by printing SKIP**
- **Files:** `runner-v2/test/qualification/scenarios/cli-config.ts` ~177–182, ~223–226
- **Failure path:** `symlinkSync` throws → `console.log("SKIP …")` → `return` → `exitScenarioMain` → exit 0 → parent treats scenario as passed. Same class of silent pass as platform `console.log("SKIP"); return` in Windows/POSIX scenario bodies.
- **Kind:** missing gate (qualification honesty); Darwin host-alias still covered in required CI via `runner-capabilities-config.test.ts`, but **capability-contract alias** is now qualification-only and can vanish
- **Repair:** under qualification/CI, fail closed (non-zero) when alias creation fails; platform mismatch in a scenario process must exit non-zero (entrypoint `t.skip` is fine; isolated process must not soft-pass).

---

## Important

**3. Prior Docker MCP qualification routes not actually mapped**
- **Files:** `runner-v2/test/qualification/README.md` ~32; `scenarios/docker-oci.ts` (only alpine + managed-strict + require gate); former `mcp-tools.test.ts` ~704–845 (strict MCP OCI identity / detached descendant)
- **Regression:** docker job used to run `mcp-tools.test.ts`; new entrypoint has no MCP-over-OCI scenario while README claims that subset is replaced
- **Kind:** missing gate/coverage mapping
- **Repair:** add 1–2 focused Docker MCP scenarios (or stop claiming the map and restore a minimal `mcp-tools` Docker subset under the docker job).

**4. Harness timeout kill is soft and does not preserve/force-release evidence**
- **File:** `qualification-harness.ts` ~216–230
- **Path:** outer timeout → `child.kill()` only → no escalate/SIGKILL, no fixture capture, no process/Job snapshot → orphaned Jobs/SQLite holders can poison later isolated scenarios on the same hosted VM
- **Kind:** missing gate (isolation/cleanup)
- **Repair:** grace then force-kill; capture diagnostics/fixture roots; optionally wait for child death before next scenario.

**5. Fixed sleep then assert (not bounded converge)**
- **File:** `scenarios/windows-lifecycle.ts` ~94–95 (`sleep 150` then `reconcile == running`)
- **Path:** hosted timing can miss running / flake after an earlier running check
- **Kind:** missing gate (test fragility), not product weakening
- **Repair:** use `boundedConverge` (pass / definitive fail / persistent unknown + supervisor evidence).

---

## Coverage conclusions (concise)

| Area | Verdict |
| --- | --- |
| Focused entrypoints vs giant monoliths | OK — workflow + leak guards point at `qualification/*.test.ts` only |
| Product deadline/semantic weakening | OK — CLI 90s is outer fixture budget; git-bootstrap close retry is consumer-boundary, tested |
| Lifecycle scopes / no POSIX ancestry authority | OK — exact-owned cleanup; `process.kill(pid,0)` is witness check only |
| Windows Job / OCI honesty | OK — real Job host + OCI provider; `REQUIRE_DOCKER=1` fail-closed on hosted docker job |
| Process isolation | Mostly OK — one Node process per scenario; timeout soft-kill weakens it (#4) |
| Evidence on every failure path | **Not OK** (#1) |
| No silent SKIP pass | **Not OK** (#2); docker hosted path OK when `REQUIRE_DOCKER=1` |
| Config/trust / Darwin host-alias | Deterministic CI retains `runner-capabilities-config`; qualification alias scenarios dishonest if SKIP (#2) |
| Recovery / managed / MCP native | Mapped to focused scenarios |
| Docker MCP | **Gap** (#3) |
| LSP | Was not a prior qualification entrypoint; large files remain; no new qualification LSP route |
| Original large files | Remain; not wholesale-imported into qualification |

---

## NOT READY

Two Blockers (#1 evidence survival, #2 silent SKIP) must be fixed before this qualification refactor is acceptance-ready.
