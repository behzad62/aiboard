# ADR-E: CLI packaging and installers

## Status

Proposed.

## Context

The Runner V2 launcher currently imports TypeScript through `tsx` (`runner-v2/bin/aiboard-runner-v2.mjs:2`); the download builder currently archives `src`, `bin` and skills and declares `tsx` plus Playwright (`scripts/publish-downloads.mjs:87`, `scripts/publish-downloads.mjs:161`). Node 24 is required (`runner-v2/package.json:5`).

## Decision

| Concern | Decision |
| --- | --- |
| Targets | Produce distinct `win-x64`, `win-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64` payloads. Each includes a release-pinned official Node 24 runtime for its OS/architecture; the release builder verifies upstream Node signatures and SHA-256 before packaging ([Node release artifacts](https://nodejs.org/dist/latest-v24.x/)). Validate native execution on each target; diagnose unsupported libc/OS rather than falling back silently. Git remains a checked external prerequisite. |
| JavaScript | Compile the launcher and Runner TypeScript ahead of time with a pinned esbuild version targeting Node 24 ESM. No runtime `tsx`, npm install or developer checkout. Bundle statically resolvable JS; retain `node:*` imports including built-in `node:sqlite`. Preserve dynamically loaded modules as a locked, integrity-inventoried runtime dependency tree when bundling would change semantics. |
| Assets and native code | Keep Playwright's package/driver external to the single JS bundle and install compatible Chromium separately, on first browser use or explicit setup, with progress/cancel and actionable offline errors (`runner-v2/src/browser-tools.ts:250`, `scripts/publish-downloads.mjs:107`). Preserve the relative-path layouts and exact bytes of supervisors, PowerShell scripts, skills, workers, provenance and the separately verified Windows helper (`runner-v2/src/native-process-backend.ts:218`, `runner-v2/src/windows-job-process-host.ts:252`, `runner-v2/src/windows-birth-inspection.mjs:16`). Inventory native addons and dynamic imports per target; ship matching verified native artifacts and fail closed when absent. Windows arm64 must have a verified supported helper/lifecycle path; the existing asset is explicitly `win-x64`, so do not assume arm64 parity. |
| Other runners | `aiboard` starts Runner V2 for cwd; `aiboard accounts`, `legacy`, `bench`, `runner accounts`, `all` and `remote` follow D8/D9. Include the account runner and its dynamically imported Copilot companion and SDK/CLI dependencies; include legacy runner with its existing library/panel bundle and bench runner with its support/evidence files (`lib/account-provider-runner.mjs:767`, `scripts/publish-downloads.mjs:358`, `scripts/build-runner.mjs:22`, `scripts/build-runner.mjs:102`, `scripts/bench-runner.mjs:9`). Keep them separate local services; the remote connector can address Runner V2 only. Certified RJS bench currently pins Node `24.18.0` and QuickJS `0.32.0` (`scripts/bench-runner.mjs:465`): retain its pinned runtime and dependencies alongside the main runtime when they differ, and run its managed children with the certified runtime; never claim certification on a different version without the applicable qualification. |
| State and reuse | Use an OS per-user data directory plus a stable canonical-project identity, always outside the project; check canonical paths including links/reparse points and refuse startup with an actionable state-directory override if no valid external location exists. Lock discovery/creation per project and reuse a healthy same-user, same-project instance. Different projects remain isolated. Explicit headless/no-open mode is supported. A fresh connection credential is distinct from the stable protected encryption key; adopt the migration in ADR-F. |

The release manifest is exact UTF-8 JSON bytes with `schemaVersion`, release version, monotonic channel sequence, creation/expiry, minimum installer version, key ID, Node versions and six artifact records `{os, arch, url, bytes, sha256}`. A detached RSA-3072/SHA-256 PKCS#1 v1.5 signature covers those exact bytes; the installer embeds the trusted public key and verifies signature before parsing or trusting URLs/hashes. The manifest and artifacts are HTTPS on approved AIBoard release origins; reject unknown key, schema, target, origin, expiry, sequence below the locally recorded high-water mark and hash mismatch. On first install there is no local high-water mark: expiry and a bootstrap-pinned minimum bound replay, but cannot prove that an unexpired signed manifest is the latest. Release signing keys remain outside the repository; support explicit, signed key rotation. Installer verification on Windows uses PowerShell 5.1/.NET RSA and SHA-256, importing embedded modulus/exponent without depending on newer .NET PEM APIs; POSIX uses `openssl` and `sha256sum` or `shasum`, checking for them and failing with a useful message if missing. The initial `irm | iex` / `curl | sh` script itself executes on receipt and therefore relies on HTTPS and the official site's integrity; the payload signature does not authenticate a compromised bootstrap script.

`install.ps1` (PowerShell 5.1+/pwsh) and POSIX `install.sh` detect OS/CPU, verify the signed manifest and artifact before extraction, reject archive traversal/links/oversize entries, stage under the user directory, run a bounded version/doctor smoke check, then atomically switch a same-volume version pointer. Windows uses `%LOCALAPPDATA%\\AIBoard`; macOS/Linux use `~/.aiboard` or XDG data/bin paths. No admin or sudo is needed. Add only the user PATH with an idempotent edit and explain shell restart. Concurrent install/update uses a per-user lock. Keep the last known-good release and never touch project or state during rollback.

`aiboard update` uses the same verifier/staging/switch and rolls back on failed activation; intentional rollback only selects an already verified local version and never lowers the accepted online channel sequence. A release must keep its state readable and safely writable by the retained previous version, including ADR-F's credential migration, or hold automatic activation until a reversible compatibility migration is available. Never silently restore an older state backup over newer user changes. `aiboard uninstall` removes the managed PATH entry and program files, retaining state by default; an explicit prompt or flag removes state. With a piped installer, obtain interactive input from the terminal, not script stdin; in noninteractive mode use documented flags and safe defaults. `doctor` reports Node/Git/ports/browser/secret-store/relay reachability without printing secrets.

Adopt from Milestone A1–A3: user+project state outside the project; instance reuse and two-project isolation; preserved encrypted state and advanced flags; one-time pairing with Origin/Host/CSRF defenses; rollback, tamper rejection, legal notices and offline diagnostics. L1/L2 replace the older milestone sequencing and the new owner decision makes browser opening the normal interactive default; headless mode remains available. The older plan and ledger identify A1/A2/A3 as proposals/open work, not an implemented installer (`D:/repos/ai-discussion-board/docs/plans/aiboard-unified-cloud-desktop-agent-platform-2026-10-15.md:140`, `docs/plans/aiboard-platform-implementation-ledger.md:9` on branch `plan/aiboard-platform-a0`, branch `plan/aiboard-platform-a0`).

Extend `scripts/publish-downloads.mjs` for the new payloads, reuse `scripts/build-runner.mjs` for the legacy artifacts, and extend `scripts/runner-v2-package-hashes.mjs` to emit per-target reports and compare independent builds of the *same* target. Its current hashes are unsigned reproducibility evidence, not the new release signature (`scripts/build-runner.mjs:117`, `scripts/runner-v2-package-hashes.mjs:22`, `scripts/runner-v2-package-hashes.mjs:45`). Extend the deployment artifact tests and package-parity checks for all payload contents and signed manifest, keeping legacy ZIP checks (`.github/workflows/deploy-aiboard.yml:30`, `.github/workflows/deploy-aiboard.yml:37`). L2's focused acceptance covers standard-user install, all six target artifacts, update/rollback/uninstall, bad signature/hash, partial extraction, retained state, and required asset launches; record CI-only macOS evidence honestly.

## Consequences

Installers require a separately managed signing key, audited bootstrap verifier and target-specific native qualification. Playwright browsers, Git and POSIX verification tools remain independently diagnosed prerequisites. Bundle tests must exercise real resource resolution, not just a successful esbuild invocation.

## Alternatives rejected

- Requiring every user to install Node/npm and execute TypeScript conflicts with the one-line distribution.
- A single self-contained JS file that omits native helpers, subprocess scripts, runtime modules or browser binaries cannot preserve current behavior.
- Unsigned hashes or verification with a key delivered only by the same unsigned manifest do not authenticate updates.

## Open questions

- Who holds the release signing key and where are signed artifacts hosted? Is the documented OpenSSL prerequisite acceptable for minimal Linux installations?
- Can the existing Windows helper be qualified under arm64, or is an independently built/pinned arm64 helper required?

## Plan corrections

`scripts/build-runner.mjs` currently bundles the legacy runner and copies account/bench artifacts, not Runner V2 (`scripts/build-runner.mjs:1`, `scripts/build-runner.mjs:108`); a separate V2 bundling step is required. A fresh V2 token cannot currently decrypt persisted provider or extension credentials: both stores use that token (`runner-v2/src/cli.ts:168`, `runner-v2/src/cli.ts:175`, `runner-v2/src/encrypted-provider-config-store.ts:50`). Split session and storage keys with migration before applying L1's fresh-token behavior.

## Evidence

Inspected AIBoard `d7ed04d2505869f5d52ac17bfd1dfe92259b112f`; Milestone A and ledger are from `plan/aiboard-platform-a0` at `47d94d13185e216574157b29d4813981246d0433`.

- `runner-v2/bin/aiboard-runner-v2.mjs:2`; `runner-v2/package.json:5`; `scripts/publish-downloads.mjs:87`; `scripts/publish-downloads.mjs:161`.
- `runner-v2/src/windows-birth-inspection.mjs:16`; `runner-v2/src/native-process-backend.ts:218`; `runner-v2/src/windows-job-process-host.ts:252`; `runner-v2/src/browser-tools.ts:250`.
- `lib/account-provider-runner.mjs:767`; `scripts/bench-runner.mjs:9`; `scripts/bench-runner.mjs:465`; `scripts/build-runner.mjs:102`.
- `scripts/runner-v2-package-hashes.mjs:22`; `.github/workflows/runner-v2-portable-execution.yml:154`; `.github/workflows/deploy-aiboard.yml:30`.
