---
name: playwright-cli
description: Browse and check web pages with the Playwright CLI the Runner ships - open a page in this agent session's browser, read its snapshot, click and type, list console errors, take screenshots kept as evidence.
---

# Browsing with playwright-cli in an AIBoard Build

<!-- Adapted from Playwright's playwright-cli agent skill (playwright-core/lib/tools/cli-client/skill/SKILL.md,
     Copyright (c) Microsoft Corporation, Apache License 2.0), edited for the AIBoard Runner: the Runner starts and
     stops the browser, and nothing is installed. -->

The Runner puts two commands on PATH for every command you run:

- `playwright-cli-session` runs this agent session's browser. Start it **once**, with `process.start`, and leave it running.
- `playwright-cli` sends one command to that browser and exits. It always uses your own session: never pass `-s`.

Nothing needs installing. Never run `npm install -g @playwright/cli`, `npx playwright install` or `playwright-cli install-browser`: a Build never downloads software. If `playwright-cli-session` says no browser is installed, browsing is not available on this machine; say so in your result (the owner can run `aiboard browser install`).

## Start the browser

```json
process.start {"command": "playwright-cli-session", "until": {"pattern": "Daemon listening on"}, "waitMs": 30000}
```

- Give it no `args` and no `cwd`: it writes its files into `.aiboard-browser/` under the folder it starts in, your workspace root.
- The browser is headless and has an empty, in-memory profile.
- It stops by itself when your session ends. To stop it earlier, run `playwright-cli close` or `process.signal` its processId.
- `playwright-cli open`, `attach`, `show`, `close-all`, `kill-all`, `--profile`, `--persistent`, `--cdp` and `--extension` are refused. Open pages with `goto`.

## Read results with `--json`

A command that fails (a page that does not load, a ref that is gone) exits 1 and prints its error. Only `--json` and plain text output are checked: `--raw` output, and the commands that print raw by default (`cookie-get`, `localstorage-get`, `response-body` and the like), exit 0 whatever they print. Put `--json` on any command whose result you read: it prints one JSON object, with `isError: true` and the error when it failed:

```bash
playwright-cli --json goto http://127.0.0.1:5173/
playwright-cli --json console error
```

## Evidence

Snapshots, console logs and screenshots without `--filename` go to `.aiboard-browser/`. Git ignores that folder, so it never lands in a commit. To keep a file as evidence, write it there with a name you choose, in the same `run_evidence_command` that keeps it:

```json
run_evidence_command {"command": "playwright-cli", "args": ["--json", "screenshot", "--filename=.aiboard-browser/home.png"], "outputs": [".aiboard-browser/home.png"]}
```

`--filename=` must point into a folder that exists (`.aiboard-browser/` does once the browser started); a missing folder fails with ENOENT.

## A typical check

```bash
# the app is already running, for example with process.start "npm run dev" until {port: 5173}
playwright-cli --json goto http://127.0.0.1:5173/
playwright-cli snapshot
playwright-cli click e15
playwright-cli fill e5 "user@example.com" --submit
playwright-cli --json console error
playwright-cli --json screenshot --filename=.aiboard-browser/after-submit.png
```

## In a final check

A final check cannot call `process.start`, so the browser is the check's program: a `start` check whose program is `playwright-cli-session`, with no args, ready on its output line, and whose steps run `playwright-cli` commands. The Runner starts the browser before the steps and stops it after them; the steps use that browser. Keep screenshots with each step's `outputs`:

```json
{"id": "home-page", "label": "home page renders", "kind": "start",
 "start": {"executable": "playwright-cli-session", "args": [], "ready": {"outputLine": "Daemon listening on"},
  "steps": [
   {"label": "open the page", "executable": "playwright-cli", "args": ["--json", "goto", "http://127.0.0.1:4173/"]},
   {"label": "screenshot", "executable": "playwright-cli", "args": ["--json", "screenshot", "--filename=.aiboard-browser/home.png"], "outputs": [".aiboard-browser/home.png"]}
  ]}}
```

A check has one program, the browser, so it browses a URL that is already served when the check runs; a page that needs a server of the check's own cannot be checked this way. `file:` URLs are blocked. A failed `playwright-cli` command exits 1, so its step, and the check, fail.

## Commands

### Core

```bash
playwright-cli goto https://playwright.dev
playwright-cli type "search query"
playwright-cli click e3
playwright-cli dblclick e7
# --submit presses Enter after filling the element
playwright-cli fill e5 "user@example.com"  --submit
playwright-cli drag e2 e8
playwright-cli drop e4 --path=./image.png
playwright-cli drop e4 --data="text/plain=hello world"
playwright-cli hover e4
playwright-cli select e9 "option-value"
playwright-cli upload ./document.pdf
playwright-cli check e12
playwright-cli uncheck e12
playwright-cli snapshot
playwright-cli eval "document.title"
playwright-cli eval "el => el.textContent" e5
playwright-cli eval "el => el.getAttribute('data-testid')" e5
playwright-cli dialog-accept
playwright-cli dialog-accept "confirmation text"
playwright-cli dialog-dismiss
playwright-cli resize 1920 1080
```

### Navigation, keyboard and mouse

```bash
playwright-cli go-back
playwright-cli go-forward
playwright-cli reload
playwright-cli press Enter
playwright-cli press ArrowDown
playwright-cli keydown Shift
playwright-cli keyup Shift
playwright-cli mousemove 150 300
playwright-cli mousedown
playwright-cli mouseup
playwright-cli mousewheel 0 100
```

### Save as

```bash
playwright-cli screenshot
playwright-cli screenshot e5
playwright-cli screenshot --filename=.aiboard-browser/page.png
playwright-cli pdf --filename=.aiboard-browser/page.pdf
```

### Tabs

```bash
playwright-cli tab-list
playwright-cli tab-new
playwright-cli tab-new https://example.com/page
playwright-cli tab-close
playwright-cli tab-select 0
```

### Storage

```bash
playwright-cli state-save .aiboard-browser/auth.json
playwright-cli state-load .aiboard-browser/auth.json
playwright-cli cookie-list
playwright-cli cookie-get session_id
playwright-cli cookie-set session_id abc123
playwright-cli cookie-clear
playwright-cli localstorage-list
playwright-cli localstorage-get theme
playwright-cli localstorage-set theme dark
playwright-cli sessionstorage-list
```

### Network and DevTools

```bash
playwright-cli route "**/*.jpg" --status=404
playwright-cli route "https://api.example.com/**" --body='{"mock": true}'
playwright-cli route-list
playwright-cli unroute
playwright-cli console
playwright-cli console warning
playwright-cli requests
playwright-cli request 5
playwright-cli run-code "async page => await page.context().grantPermissions(['geolocation'])"
playwright-cli tracing-start
playwright-cli tracing-stop
playwright-cli generate-locator e5 --raw
playwright-cli highlight e5
playwright-cli highlight --hide
```

## Raw output

`--raw` strips page status, generated code and snapshot sections and returns only the result value:

```bash
playwright-cli --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))"
playwright-cli --raw snapshot
```

## URLs with `&` on Windows

`cmd.exe` and PowerShell treat `&` as a command separator. Pass the URL as its own `args` entry of `process.run`, or quote it: `"https://example.com/?a=1^&b=2"` in `cmd.exe`, `--% goto "https://example.com/?a=1&b=2"` in PowerShell.

## Snapshots and targeting

After each command the CLI prints the page state and a link to the snapshot file, for example `[Snapshot](.aiboard-browser/page-2026-02-14T19-22-42-679Z.yml)`; read it with `fs.read`. `playwright-cli snapshot` prints the tree inline; `--depth=4` or a ref (`snapshot e34`) keeps it short, and `--boxes` adds bounding boxes.

Use the refs from the snapshot (`click e15`). CSS selectors and Playwright locators work too: `click "#main > button.submit"`, `click "getByRole('button', { name: 'Submit' })"`, `click "getByTestId('submit-button')"`.
