# Runner Page Error Evidence Design

## Problem

Runner V2 launches a real headless Playwright browser, but its browser event collector only subscribes to `console`, `response`, and `requestfailed`. Playwright emits uncaught page exceptions through `pageerror`, so a rendering loop can throw repeatedly while DOM-based snapshots continue to show gameplay progress. The Architect then receives mechanically incomplete evidence and may approve a broken web app.

## Design

`PlaywrightBrowserBackend` will subscribe to Playwright's `pageerror` event for every new and recovered browser session. Each exception will be normalized into the existing bounded console-event stream as an event with `type: "error"`; its text will preserve the exception stack when available and otherwise the message. This keeps the BrowserBackend contract backward-compatible and makes existing `browser.events` evidence counting treat page exceptions as errors without adding a semantic verdict.

The Runner will remain headless by default. Verifiers continue to gather mechanical facts only, and the Architect remains responsible for deciding whether the observed errors prevent completion.

## Verification

A real Playwright regression test will serve a page that throws an uncaught exception after load. The test must fail before implementation because `browser.events` lacks the error, and pass after implementation by finding an `error` event containing the exception message. Existing browser tool, evidence-counting, recovery, and delayed-import tests must remain green.

