# Runner Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the zero-dependency runner into a self-managing local daemon with a browser control panel (folder browser, live logs, MCP management), opt-in network access, version awareness, and signed self-update.

**Architecture:** All runner logic stays in the single `scripts/runner.mjs`. The panel is authored as a standalone zero-dependency HTML/JS file (`scripts/runner-panel.html`) and **inlined into `runner.mjs` at build time** by a new `scripts/build-runner.mjs` (which replaces the inline `copy-runner` npm script). The panel talks to the runner over the same-origin HTTP API. Security hardening (Host/Origin guard, confinement, token) is added ahead of the existing handlers.

**Tech Stack:** Node 18+ (built-ins only: `http`, `https`, `crypto`, `fs`, `path`, `child_process`, `stream`), vanilla HTML/CSS/JS for the panel, tsx PASS/FAIL test scripts (no runner), Playwright for live verification.

**Spec:** `docs/superpowers/specs/2026-06-22-runner-control-panel-design.md`

**Reference (current runner):** flags `:80-140`, CORS/auth helpers `:143-157`, server + auth gate + `/health` `:1681-1704`, route table `:1695-2210`, teardown `:1668-1678`, `listen` `:2213`. `VERSION = 8` at `:46`.

---

## Phasing

- **Phase 1 — Secure foundation + folder browser + live logs + minimal panel** (this document, full detail). Self-contained and live-testable: load the panel from the runner, browse/select a folder, watch logs stream, with the security guard in place.
- **Phase 2 — MCP management + version awareness + signed self-update** (planned after Phase 1 lands; own plan doc).
- **Phase 3 — Network mode (`--host`, LNA UX) + help guide + main/about copy** (planned after Phase 2; own plan doc).

Each phase produces working, tested software and is committed before the next begins.

---

## File Structure (Phase 1)

- **Modify `scripts/runner.mjs`** — add, in order, ahead of the existing route table: a constant-time token check, a Host/Origin request guard, a `confine()` filesystem chokepoint, a structured `logEvent()` sink (ring buffer + SSE subscribers + unchanged stdout formatter), folder-browser routes (`/api/fs/list`, `/api/fs/root`), a log feed (`/api/logs/stream` SSE + `/api/logs` poll + nonce mint), and an unauthenticated shell route (`GET /`) serving the inlined panel. Existing routes are reachable under both their current path and an `/api/*` alias.
- **Create `scripts/runner-panel.html`** — standalone panel: header (version, connection, root), folder browser, live log pane. No external assets; one `<style>` + one `<script>`.
- **Create `scripts/build-runner.mjs`** — copies `scripts/runner.mjs` → `public/runner.mjs`, inlining `runner-panel.html` at a marker. Replaces the `copy-runner` npm one-liner.
- **Modify `package.json`** — point `copy-runner` at `node scripts/build-runner.mjs`.
- **Create `scripts/test-runner-confine.mts`** — confinement unit tests.
- **Create `scripts/test-runner-guard.mts`** — Host/Origin guard + token unit tests.
- **Create `scripts/test-runner-panel-build.mts`** — asserts the build inlines the panel (no leftover marker, panel markup present).

The new runner logic is factored into named helpers (`isAllowedHost`, `isAllowedOrigin`, `confine`, `logEvent`, `serveShell`, `listDirs`, `mintLogNonce`) so each is independently testable by importing from a small extracted module where practical, or covered via the runner's own endpoints.

---

## Phase 1 Tasks

### Task 1: Constant-time token check + token entropy floor

**Files:**
- Modify: `scripts/runner.mjs` (`authorized()` at `:155-157`, token init at `:83`)
- Test: `scripts/test-runner-guard.mts`

- [ ] **Step 1: Write failing test** for a `tokensMatch(a, b)` helper exported from runner via a guard module. Create `scripts/runner-guard.mjs` exporting `tokensMatch`, `isAllowedHost`, `isAllowedOrigin` (pure functions, no server). Test: `tokensMatch("abc","abc") === true`, `tokensMatch("abc","abd") === false`, `tokensMatch("abc","ab") === false` (length-mismatch safe).
- [ ] **Step 2:** Run `npx tsx scripts/test-runner-guard.mts` → FAIL (module missing).
- [ ] **Step 3:** Implement `scripts/runner-guard.mjs`: `tokensMatch` uses `crypto.timingSafeEqual` on equal-length `Buffer`s, returns false on length mismatch without throwing. `runner.mjs` imports `tokensMatch` and uses it in `authorized()`.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit `feat(runner): constant-time token comparison`.

### Task 2: Host + Origin request guard

**Files:**
- Modify: `scripts/runner-guard.mjs`, `scripts/runner.mjs` (server handler `:1681`)
- Test: `scripts/test-runner-guard.mts`

- [ ] **Step 1: Write failing tests** for `isAllowedHost(hostHeader, {port, host})` and `isAllowedOrigin(originHeader, {appOrigins})`:
  - Host: `127.0.0.1:8787`, `localhost:8787`, `[::1]:8787` allowed for default; `evil.com:8787` rejected; with `host:"0.0.0.0"` configured, the exact bound host allowed.
  - Origin: absent (`undefined`/`null`) → allowed (top-level nav); `https://aiboard.me` allowed; `http://localhost:3000` and `http://127.0.0.1:3000` allowed; `https://evil.com` rejected; an extra `--app-origin` value allowed.
- [ ] **Step 2:** Run test → FAIL.
- [ ] **Step 3:** Implement both helpers in `runner-guard.mjs`. In `runner.mjs`, at the top of the request handler (before the `OPTIONS`/auth logic), compute `Host`/`Origin` checks; on failure `json(res, 403, {error:"Forbidden host/origin"})` and return. CORS `Access-Control-Allow-Origin` is set to the request Origin when allowed (else omitted), replacing `*`. Parse `--host` and `--app-origin` flags (default app origins: `https://aiboard.me`, `http://localhost:3000`, `http://127.0.0.1:3000`).
- [ ] **Step 4:** Run test → PASS. Also run existing `npx tsx scripts/test-runner-github-workflow.mts` to confirm no regression in the runner test that mocks endpoints.
- [ ] **Step 5:** Commit `feat(runner): Host/Origin allowlist guard (DNS-rebinding defense)`.

### Task 3: `confine()` filesystem chokepoint + default root = cwd

**Files:**
- Create: `scripts/runner-fs.mjs` (exports `confine`, `listDirs`, `driveRoots`)
- Modify: `scripts/runner.mjs` (root resolution near `:81`)
- Test: `scripts/test-runner-confine.mts`

- [ ] **Step 1: Write failing tests** (use a temp dir tree + a symlink):
  - `confine(root, root)` → returns realpath(root).
  - `confine(root, join(root,"sub"))` → ok.
  - `confine(root, join(root,"..","sibling"))` → throws (escape).
  - `confine(root, join(root,"rootEVIL"))` where a sibling `rootEVIL` exists → throws (trailing-sep boundary).
  - A symlink inside root pointing outside → `confine` throws (realpath resolves it).
  - Null byte / reserved name (`CON`) target → throws.
  - When `root` is a drive/`/`, a normal child resolves ok.
- [ ] **Step 2:** Run `npx tsx scripts/test-runner-confine.mts` → FAIL.
- [ ] **Step 3:** Implement `confine(root, target)`: resolve `path.resolve(root, target)`, then `fs.realpathSync` the nearest existing ancestor, re-append the unresolved tail, and require `resolved === realRoot || resolved.startsWith(realRoot + path.sep)`; reject null bytes and Windows reserved device names; on Windows compare with lowercased drive letters. `listDirs(dir)` returns `{name, path}[]` of subdirectories (errors → empty). `driveRoots()` returns `['/']` on POSIX or the probed `A:\`–`Z:\` drives on Windows (parallel `opendir` with per-drive timeout). In `runner.mjs`, set `const root = path.resolve(positional[0] ?? process.cwd())` and store both `root` (boundary) and a mutable `activeDir` (initially `root`).
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit `feat(runner): confine() filesystem chokepoint + cwd default root`.

### Task 4: Route existing file ops through `confine`

**Files:**
- Modify: `scripts/runner.mjs` (`safeResolve`/file endpoints — `/read`, `/write`, `/patch`, `/append`, `/read-range`, `/ls`, `/search`)

- [ ] **Step 1:** Identify the current path-resolution helper (`safeResolve` or equivalent) used by file endpoints; write a quick test in `test-runner-confine.mts` asserting a crafted `../` path is rejected by that helper after the change.
- [ ] **Step 2:** Run → FAIL (if currently permissive) or confirm coverage.
- [ ] **Step 3:** Replace the file endpoints' resolution with `confine(root, rel)` (boundary = `root`, not `activeDir`, so the browser's chosen folder can move within the root). Keep behavior identical for in-root paths.
- [ ] **Step 4:** Run `npx tsx scripts/test-runner-confine.mts` and the existing runner tests → PASS.
- [ ] **Step 5:** Commit `feat(runner): route all file ops through confine()`.

### Task 5: Structured logging — ring buffer + unchanged stdout

**Files:**
- Create: `scripts/runner-log.mjs` (exports `createLog`)
- Modify: `scripts/runner.mjs` (replace `console.log`/`console.error` operational lines)
- Test: extend `scripts/test-runner-guard.mts` or new `scripts/test-runner-log.mts`

- [ ] **Step 1: Write failing test** for `createLog({capacity})` → `{ log, snapshot, subscribe, format }`: `log({level:'info',category:'sys',msg:'hi'})` appends an event with a monotonic `seq` and a `ts`; `snapshot(sinceSeq)` returns events after `sinceSeq`; `format(event)` reproduces the legacy one-line string (e.g. `hi`); ring buffer caps at `capacity`.
- [ ] **Step 2:** Run `npx tsx scripts/test-runner-log.mts` → FAIL.
- [ ] **Step 3:** Implement `createLog`: in-memory array capped at capacity, monotonic seq, subscriber set (callbacks for SSE), `format` matching current stdout. In `runner.mjs`, construct `const L = createLog({capacity:2000})`; route operational logging through `L.log(...)` which also writes `L.format(event)` to real stdout so the terminal is unchanged. Convert the startup banner + per-request operational lines.
- [ ] **Step 4:** Run test → PASS; start the runner manually and eyeball that stdout still looks like before.
- [ ] **Step 5:** Commit `feat(runner): structured logging with ring buffer (stdout unchanged)`.

### Task 6: Log feed — SSE stream + poll + single-use nonce

**Files:**
- Modify: `scripts/runner.mjs` (new routes), `scripts/runner-log.mjs` (nonce store)
- Test: `scripts/test-runner-log.mts`

- [ ] **Step 1: Write failing test** for a nonce store: `mintNonce()` returns a token; `consumeNonce(t)` returns true once then false (single-use); nonces expire after a TTL.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the nonce store in `runner-log.mjs`. Add routes: `POST /api/logs/nonce` (auth'd) → `{nonce}`; `GET /api/logs/stream?nonce=` → validate+consume nonce, set `text/event-stream`, replay recent snapshot, then push each new event via subscribe; `GET /api/logs?since=<seq>` (auth'd) → `{events, lastSeq}`. SSE handler removes its subscriber on `req.close`.
- [ ] **Step 4:** Run test → PASS; manual `curl` the poll endpoint with the token.
- [ ] **Step 5:** Commit `feat(runner): SSE log stream + poll fallback with single-use nonce`.

### Task 7: Folder-browser API

**Files:**
- Modify: `scripts/runner.mjs` (routes `/api/fs/list`, `/api/fs/root`, `/api/status`)
- Test: `scripts/test-runner-confine.mts` (extend)

- [ ] **Step 1: Write failing test** that, given a temp root, `listDirs` + the confine boundary produce the expected subdir list and reject escapes. (Endpoint-level behavior is covered manually; the helpers are unit-tested.)
- [ ] **Step 2:** Run → FAIL/confirm.
- [ ] **Step 3:** Add `GET /api/fs/list?path=` → if `path` empty, return `driveRoots()` (Windows) or the root's children; else `confine(root, path)` then `listDirs`. `POST /api/fs/root {path}` → `confine(root, path)`, reject if a build lock is set, set `activeDir`, persist to a config file (`<root>/.aiboard-runner.json` or alongside), `L.log` it, return new status. `GET /api/status` → `{version, root, activeDir, host, port, accessLevel}`.
- [ ] **Step 4:** Run tests → PASS; manual curl.
- [ ] **Step 5:** Commit `feat(runner): folder-browser + re-root API`.

### Task 8: Panel HTML/JS

**Files:**
- Create: `scripts/runner-panel.html`

- [ ] **Step 1:** Author a standalone page: reads `#token` fragment → `sessionStorage` → `history.replaceState` scrub (falls back to a paste box). Header shows version + connection dot + current root/activeDir. Folder browser: breadcrumb + dir list (calls `/api/fs/list`), "Use this folder" (`POST /api/fs/root`). Log pane: mints a nonce (`POST /api/logs/nonce`), opens `EventSource('/api/logs/stream?nonce=...')`, renders events with level colors + a level filter; on SSE error, falls back to polling `/api/logs?since=`. All `/api/*` calls send `x-runner-token`. Dark theme matching the app's palette via inline CSS variables.
- [ ] **Step 2:** Lint by loading the file directly in a browser tab against the running runner (manual) — deferred to Task 10 live test.
- [ ] **Step 3:** Commit `feat(runner): standalone control-panel page`.

### Task 9: Build inlines the panel; shell route serves it

**Files:**
- Create: `scripts/build-runner.mjs`
- Modify: `package.json` (`copy-runner`), `scripts/runner.mjs` (shell route `GET /`)
- Test: `scripts/test-runner-panel-build.mts`

- [ ] **Step 1: Write failing test:** running `node scripts/build-runner.mjs` produces `public/runner.mjs` that (a) contains the panel markup, (b) contains no `__RUNNER_PANEL_HTML__` marker, (c) is valid JS (`node --check public/runner.mjs`).
- [ ] **Step 2:** Run `npx tsx scripts/test-runner-panel-build.mts` → FAIL.
- [ ] **Step 3:** In `runner.mjs`, add `const PANEL_HTML = "__RUNNER_PANEL_HTML__";` and a `GET /` route (BEFORE the auth gate, AFTER the Host guard) that serves `PANEL_HTML` as `text/html` with CSP/`X-Frame-Options: DENY`/`Referrer-Policy: no-referrer`. `build-runner.mjs`: read `runner.mjs`, replace the `"__RUNNER_PANEL_HTML__"` literal with the JSON-stringified contents of `runner-panel.html`, write `public/runner.mjs`. Point `package.json` `copy-runner` to `node scripts/build-runner.mjs`. (Dev/source `runner.mjs` keeps the marker; only the built copy is inlined — so `GET /` on the source file shows a "run the build" stub, which is fine since the served runner is always the built one.)
- [ ] **Step 4:** Run `npx tsx scripts/test-runner-panel-build.mts` → PASS; `node --check public/runner.mjs` → ok.
- [ ] **Step 5:** Commit `feat(runner): inline panel at build + unauthenticated shell route`.

### Task 10: Live verification (Playwright)

- [ ] **Step 1:** `node scripts/build-runner.mjs` then start the built runner against a temp project: `node public/runner.mjs <temp-root> --port 8799 --token livetest123`.
- [ ] **Step 2:** Playwright navigate to `http://127.0.0.1:8799/#token=livetest123`. Assert: header shows version + connected; fragment scrubbed from URL.
- [ ] **Step 3:** Browse folders, click "Use this folder" on a subdir, assert the active dir updates and a log line appears.
- [ ] **Step 4:** Trigger an action that logs (e.g., an authed `/ls`), assert it streams into the log pane live.
- [ ] **Step 5:** Negative checks via curl: `GET /` with a bad `Host` header → 403; `/api/status` without token → 401; `/api/fs/list` with `path=../..` escape → confined/empty. Screenshot the working panel.
- [ ] **Step 6:** Commit `test(runner): live-verified control panel (folder browser + live logs)` and update this plan's checkboxes.

---

## Phase 2 Tasks (outline — full plan written after Phase 1 lands)

- **MCP management:** `POST /api/mcp` (add+spawn+persist), `DELETE /api/mcp/:name` (kill+deregister), `POST /api/mcp/:name/enable` (toggle); config persistence; panel MCP table with status/health/enable checkbox. Tests for the config round-trip + lifecycle.
- **Version awareness:** bump `RUNNER_VERSION`; `build-runner.mjs` emits `public/runner-manifest.json` (`{version, sha256, sig, url}`) and stamps the version into the app; `components/RunnerSetup.tsx` shows `Download runner.mjs (vN)`; connected-runner version compare → "update available" nudge.
- **Signed self-update:** Ed25519 keypair (private key in a release-only location, public key pinned in `runner.mjs`); `scripts/sign-runner.mjs` signs the built file; `POST /api/update/check` + `/api/update/apply` implementing the verified download → signature+hash → atomic swap → teardown → re-exec sequence with `.bak` rollback; never mid-build. Tests for verify-accept/reject + `preservedArgv`.

## Phase 3 Tasks (outline — full plan written after Phase 2 lands)

- **Network mode:** `--host` fail-closed (refuse non-loopback without ≥128-bit token); strong-token entropy check; loud plaintext warning; `listen` on the configured host; LNA permission pre-check + `targetAddressSpace` in the app's fetch path; remediation UX.
- **Help guide:** author once; render as an app page linked from `components/RunnerSetup.tsx`; inline into the panel's Help tab via the build. Covers flags, folder/root, MCP, tunnels (ngrok→Tailscale→Cloudflare named; `trycloudflare` banned), LNA, self-update.
- **Copy updates:** `app/page.tsx` (dashboard runner-setup copy), `components/RunnerSetup.tsx`, and `app/about/page.tsx` updated to describe the panel, network access, and self-update — only after the features actually ship.

---

## Self-Review (Phase 1)

- **Spec coverage:** Host/Origin guard ✓ (T2), confine + cwd root ✓ (T3/T4), structured logging + SSE + poll + nonce ✓ (T5/T6), folder browser ✓ (T7), unauthenticated shell + `/api` + inline build ✓ (T9), panel ✓ (T8), live test ✓ (T10). MCP CRUD / version / self-update / network / help → Phases 2–3 (intentionally deferred).
- **Placeholder scan:** task steps name exact files, helpers, and expected test outcomes; code-heavy helpers (`confine`, guard, nonce) specified by behavior + signature.
- **Type consistency:** helper names are stable across tasks — `tokensMatch`, `isAllowedHost`, `isAllowedOrigin` (runner-guard.mjs); `confine`, `listDirs`, `driveRoots` (runner-fs.mjs); `createLog` → `{log, snapshot, subscribe, format}` + nonce store (runner-log.mjs). `root` = boundary, `activeDir` = working folder, used consistently.
