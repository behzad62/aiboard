# Runner V2 execution safety guide

Runner V2 is the native Build kernel. Execution is capability-driven: Runner validates the persisted run capability contract, prepares the centrally filtered child environment, issues the exact grant for the requested operation, and selects an implementation whose attested semantic capabilities satisfy that grant.

## Permission profiles and confinement

Strict profiles fail closed. They never fall back to a native host command when the configured provider cannot prove the required capability. A strict OCI selection is provider-specific enforcement: the configured provider must attest its CLI and immutable image and return the owned execution plan for the exact lease/grant. Native execution, the Docker CLI process itself, and partial or unverified providers are not described as universally confined.

`full` is an explicit bypass, persistently disclosed as `unconfined_explicit_full`; it is not confinement. Full may authorize otherwise guarded effects according to run policy. A Build's final project handoff pauses for a user choice unless the run's policy is `finish` or `budgeted`, a project handoff was requested, and no known defects are recorded; a failed automatic apply pauses for the user.

Windows Job Objects are an optional host enhancement. Portable Windows behavior remains the baseline; Job support is used only from current semantic capability evidence and is never a Windows-only product requirement.

## Exact grants and configured OCI

Runner-issued grants are bounded claims tied to run/invocation, permission profile, and canonical read/write/create roots and modes. A model cannot author or widen a grant, choose routine cleanup, or turn an unavailable strict capability into Full.

OCI isolation is explicit configuration. Each `isolationProviders` entry supplies an absolute `cliPath`, image, and `allowNetwork`. Strict execution depends on that configured provider being available and attestable; Runner does not silently discover a replacement or switch to native while retaining a confinement claim. Durable OCI ownership binds provider, image, labels, container/lease, run/invocation/grant, and cleanup state so restart cleanup can revalidate exact ownership before removal.

## Startup, shutdown, output, and recovery

Before the control server accepts work, Runner executes owned recovery for processes, backends, isolation/OCI leases and containers, grants, spills, and temporary roots. The startup `covers` declaration is a composition-time completeness assertion, not cleanup proof by itself; concrete runtime/provider recovery must still settle without a blocker. Unresolved active-resource or settled-owned cleanup produces a typed startup blocker and readiness is not published. A terminal historical reader that owns no live resources may fail diagnostically without converting old read-only history into a startup blocker.

Shutdown closes owned resources in reverse composition order. Successful closes are remembered; a retry acts only on resources whose cleanup failed. Cleanup failure remains a typed blocker. Runner never substitutes ambient/raw process launch or model-authored routine cleanup for an owned cleanup path. Historical ambiguous records are evidence, not deletion authority.

Streaming output is bounded by the durable provider window. Lossy evidence is recorded and surfaced instead of silently presented as complete. Spill ownership and cleanup stay inside Runner-managed state.

Exceptional AI-assisted process recovery is a separate explicit path using the configured Architect runtime and durable recovery records. It does not replace deterministic lifecycle/cleanup, and a recovery record alone does not prove cleanup.

## Filesystem freshness limitation

Trusted filesystem mutation captures path identity and expected content/revision, rechecks them before publication, and fails typed on conflicts, aliasing, unsupported primitives, or identity changes. It is deliberately **not** an atomic compare-and-swap against an uncontrolled external writer and is not a kernel filesystem sandbox. An external process can still race between checks; atomic replacement preserves complete bytes but does not promise ACL/xattr preservation or crash durability.

## Settings and keys: the AIBoard home

The user's settings and keys live in the AIBoard home, one per-user folder that every AI Board surface reads: `AIBOARD_HOME` when set (an absolute folder the user owns; on POSIX not group- or world-writable, otherwise every surface refuses with `home_unsafe`), else `~/.aiboard` (`C:\Users\<user>\.aiboard` on Windows).

- `config.json` holds providers, enabled models, custom models (without keys) and settings, with no secret. Readers derive "has a key" and the key hints from `credentials.json`.
- `credentials.json` is an AES-256-GCM envelope encrypted with the home key, 32 bytes at `<user data root>/home-key`, outside the home, so a copied or synced home never carries usable keys. Keys saved under another computer's home key are refused with `home_key_mismatch` until `aiboard keys reset` replaces them.
- `home-lock.sqlite` serializes writers. Every write re-reads both files and applies one batch of ops at a base revision; a batch touching a section that changed meanwhile is refused with `home_conflict`, so a concurrent edit is never lost silently.
- A key is used only while the provider's or custom model's upstream equals the one it was saved for, and a change of base URL removes that key.
- Account-backed models (ChatGPT and Copilot through the account peer) keep their settings in the home but never a credential: the launcher supplies the peer's address and token at call time.
- Every tool broker denies `credentials.json`, `home-lock.sqlite` and the home key to every actor, and denies writes to `config.json`. Any process of the user's account can still read the files, as with other CLIs that keep keys in the user folder; there is no passphrase, so tasks can run unattended. A command run at an unconfined access level can read them too.
- `aiboard uninstall --remove-state` deletes the home's files with the rest of AI Board's data; without it they stay.

The web reads and writes the home only through the Runner (`GET /v2/home`, `POST /v2/home`) and keeps no key in the browser. Browser model calls go through the Runner's model proxy, which swaps a short-lived proxy token for the key in the home and forwards the call to the provider; ChatGPT and Copilot go through the account peer.

From a terminal:

~~~
aiboard config [--json]                               # where the home and its key are; providers with key hints; enabled models; defaults
aiboard config set defaults.reasoningEffort <effort>  # the default reasoning effort
aiboard keys set <provider> [--stdin]                 # prompts with echo off; --stdin reads one line from a pipe
aiboard keys remove <provider>
aiboard keys reset [--yes]                            # after a confirmation, removes every saved key (home_key_mismatch)
aiboard models [--json]                               # every enabled model
aiboard models enable <provider:model>
aiboard models disable <provider:model>
~~~

These commands start no Runner, make no network call, and write through the home lock, retrying once on `home_conflict`. They refuse inside an AIBoard task or a Runner's child, so a task cannot rewrite the user's home. A key is never taken from argv; at a terminal the prompt echoes nothing, and a stdin that is not a terminal is read only with `--stdin` (a leading BOM and a trailing CR or LF are stripped). A key saved this way shows as not validated until Settings validates it. `aiboard models enable` refuses an id with an unknown provider and names the nearest catalog ids. Custom models and pricing are edited in Settings.

## Final checks: the Runner records, the Architect decides, the owner sets what is mandatory

Before planning, and again on each resume, the Runner records a tool inventory: Git, Node, the executable of every suggested check looked up on PATH with its version line, and a browser the Playwright CLI can use. It decides nothing from it.

The final check is a list the Architect writes (verification contract version 2; a run started before it keeps the four fixed categories to its end). The Runner offers suggested checks. The Architect keeps each one, changes its command, or skips it with a reason, and may add its own. Kinds are `build`, `tests`, `start` and `other`; there is no browser kind. Each check ends `passed`, `failed`, or `not_run`:
- `not_run: tool_missing` is recorded by the Runner alone, from its own lookup, when a check's executable is not on PATH. It is never a failure: no repair task, no repair cycle.
- `not_run: skipped` is the Architect's skip, with its reason.
- A launch that fails with the tool present stays a failure, and failures are repaired by check id.

**Project checks.** A project declares its checks in `aiboard-validation.json` at the repository root, version 2. `mandatory` is set only there: the Architect cannot skip or change a mandatory check. When a project declares `checks`, they are the whole suggestion list; what the Runner detects from the project's files (package.json scripts, the language families, Vite or Next start) is the fallback only for a project that declares none, and a Next app with `output: "export"` gets no `next start` suggestion. The `tiers` of a version-1 file still drive the per-task boundary, and a version-1 file reads as before. Commands are an executable and an args list, never a shell string; `node` runs the Runner's own Node. Unknown keys, a malformed check, and `checks` in a version-1 file fail closed; a version above 2 asks for a newer Runner.

~~~json
{
  "version": 2,
  "checks": [
    { "id": "typecheck", "label": "Type check", "kind": "build", "mandatory": true,
      "run": { "executable": "npm", "args": ["run", "typecheck"], "timeoutMs": 600000 } },
    { "id": "unit", "label": "Unit tests", "kind": "tests", "mandatory": false,
      "run": { "executable": "npm", "args": ["test"] }, "environment": { "CI": "1" } },
    { "id": "serve", "label": "The server answers", "kind": "start", "mandatory": false,
      "start": { "executable": "node", "args": ["server.js", "--port", "{port}"],
        "ready": { "http": { "path": "/health", "status": 200 } },
        "steps": [{ "label": "Smoke script", "executable": "node", "args": ["scripts/smoke.mjs", "{port}"], "outputs": ["smoke-report.json"] }] } }
  ]
}
~~~

`run` takes `cwd` (inside the checkout) and `timeoutMs`, and a run check may set `environment`. A `start` check runs a program and sees that it works: ready on an HTTP status on the port the Runner leases (its args take `{port}`), on a line the program prints (`{ "outputLine": "..." }`, stdout or stderr), or on its exit code (`{ "exitCode": 0 }`); its `steps` run in order against the started program (their args take `{port}` too) and must each exit 0. `outputs` lists workspace paths or globs kept as evidence files (at most 32 files); images go to reviewers whose model accepts images.

**When a Build stops for its checks.** Only critical matters stop a Build:
- A mandatory check whose tool is missing pauses once, before planning and before any model call, naming the tool, the check and its `aiboard-validation.json` line. Install the tool and resume; each resume takes a new inventory.
- A malformed or unreadable `aiboard-validation.json` also stops the run before planning. The run reads the file at its own starting revision, so resuming cannot fix it: fix the file and start a new Build.
- A mandatory check that still fails at its repair limit pauses, as before.
- A non-mandatory check that still fails at its repair limit becomes a known defect, and the Build goes on to its handoff, which pauses for the owner's choice.

**Not verified.** The handoff has a Not verified section, and Run details shows the same list: every `not_run` check with its missing tool or skip reason, every known defect at the repair limit, every criterion accepted on an Architect override without Runner evidence, and the Architect's `leftToVerify` items from `complete_run` (things only the owner can check, such as an installer on another operating system). Nothing in it pauses the Build.

## Browsing: the Playwright CLI

Builds browse through the Playwright CLI bundled with the Runner, as ordinary commands. Workers, the Architect and the verifiers can run `playwright-cli`, which the Runner puts first on PATH for every process it starts for them, and its skill is offered to them. Each agent session gets one browser session, started once with `process.start` of `playwright-cli-session` until `Daemon listening on`, and stopped with its owner like any managed process; two tasks never share one. Screenshots and snapshots go to `.aiboard-browser/` in the workspace, which never lands in a task commit; `outputs` on `run_evidence_command` keeps them as evidence files. New runs have no `browser.*` tools; a run started before this change keeps them on resume and replay. A final check cannot start a browser session yet, so a `start` check's steps cannot browse.

The CLI uses an installed Google Chrome first, then Microsoft Edge, then Playwright's Chromium. A Build never downloads a browser: `aiboard browser install`, or the Install browser button in Settings > Tools, downloads Playwright's Chromium, only on the owner's action. On Linux, Chromium's system libraries need root, so the Runner prints the command for the owner to run and never runs it. Playwright MCP is not a default; add it as an MCP extension to use it.

See [architecture](./architecture.md) for ownership composition and [security](./security.md) for threat-boundary details.
## Test integrity in new planning runs

A new opt-in planning run pins its test command and tracked test configuration to an immutable trusted revision. Before independent delivery review, Runner measures the initial suite in a separate owned checkout. It records executed cases as passed plus failed; skipped and selected cases cannot substitute for execution. A completed failing baseline can establish its count. Missing, unsupported, malformed, zero-test or skipped-only reports cannot.

An unexplained command/configuration change stops boundary execution. A smaller measured suite produces a separate integrity failure while the raw test result stays unchanged. The Architect can authorize specific changes with an exact current-plan reason and minimum executed count. An independent reviewer can explicitly accept obsolete or merged tests by naming affected test IDs and where their behavior remains proven. Ordinary approval text grants no exception. Both forms bind the exact plan, submission, baseline and candidate fingerprints, and acceptance checks those identities again.

An initial project with no configured suite uses an immutable Git inventory proof with no invented denominator or report. Its first suite may be introduced, but acceptance still requires a fresh positive machine-readable test report. Detected tests or runner configuration without a usable command remain blocked. A successful task acceptance atomically promotes the trusted baseline; a passed boundary or failed attempt alone cannot.

Historical runs retain their recorded policy and are not automatically upgraded on recovery. These runtime project checks are separate from repository development validation: packet tests run during implementation, and the full development suite (`npm run test:runner-v2`, which takes hours) runs in CI or by the owner. P6.6 and T8 were accepted on 2026-10-15.

## Submission scope and secret checks

New opt-in planning runs inspect the exact Git tree before creating the task commit and submitted diff. Paths outside the active packet claim, forbidden surfaces, unclaimed instruction/control files, and newly added progress/evidence/review/test-output records produce durable blocking scope findings. Submission continues so the Architect can resolve those findings explicitly, with a rationale bound to the exact current ready plan. Reviewer omission or ordinary approval prose cannot clear them.

Added secret patterns and newly added environment/key files refuse submission with a generic redacted reason. The refused candidate does not become a task commit or submitted change set. These checks target the submission boundary; private tool audit output is not claimed to be free of secret bytes. The stored submitted diff disables external converters, text conversion and forced color so it retains the inspected Git representation.

Runner captures the exact task attempt, worker session, assignment claim and plan before releasing the claim. Only the trusted scheduler may publish the guarded submission record. Historical activation-free runs retain their recorded behavior.
