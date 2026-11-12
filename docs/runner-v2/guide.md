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
