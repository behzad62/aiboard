import assert from "node:assert/strict";
import test from "node:test";

import type { FinalVerificationBrowserEventsFact } from "../src/final-verification-runtime.js";
import { assertFinalVerificationCheckSemantics } from "../src/final-verification-semantics.js";

const REVISION = "a".repeat(40);
const WORKSPACE = "C:/verification";
const REQUESTED_URL = "http://127.0.0.1:4173/";
const OBSERVED_URL = "http://127.0.0.1:4173/home";

test("direct semantics recomputes console, page, and network policy violations", () => {
  for (const events of [
    browserEvents({
      consoleEventCount: 1,
      consoleErrorCount: 1,
      consoleErrors: [consoleEvent("error", "console exploded", "console")],
    }),
    browserEvents({
      consoleEventCount: 1,
      pageErrors: [consoleEvent("pageerror", "page exploded", "pageerror")],
    }),
    browserEvents({
      networkEventCount: 1,
      networkFailureCount: 1,
      failedNetworkEvents: [networkEvent(503)],
    }),
  ]) {
    assert.throws(
      () => assertFinalVerificationCheckSemantics(semanticInput(events)),
      /policy violation|console error|page error|network failure/i,
    );
  }
});

test("direct semantics accepts exact allowlisted browser failures and normal redirects", () => {
  const events = browserEvents({
    consoleEventCount: 2,
    consoleErrorCount: 1,
    networkEventCount: 1,
    networkFailureCount: 1,
    consoleErrors: [consoleEvent("error", "known console noise", "console")],
    pageErrors: [consoleEvent("pageerror", "known page noise", "pageerror")],
    failedNetworkEvents: [networkEvent(503, "known endpoint")],
  });
  assert.doesNotThrow(() => assertFinalVerificationCheckSemantics(semanticInput(events, {
    allowedConsoleErrorPatterns: ["known console"],
    allowedPageErrorPatterns: ["known page"],
    allowedNetworkFailurePatterns: ["known endpoint"],
  })));
});

test("direct semantics rejects malformed captured browser events and inconsistent counts", () => {
  const cases: FinalVerificationBrowserEventsFact[] = [
    browserEvents({
      consoleEventCount: 1,
      consoleErrorCount: 1,
      consoleErrors: [{ type: "error" } as never],
    }),
    browserEvents({
      consoleEventCount: 1,
      pageErrors: [consoleEvent("info", "not a page error", "console")],
    }),
    browserEvents({
      networkEventCount: 1,
      networkFailureCount: 1,
      failedNetworkEvents: [networkEvent(200)],
    }),
    browserEvents({
      consoleEventCount: 0,
      pageErrors: [consoleEvent("pageerror", "hidden page error", "pageerror")],
    }),
    browserEvents({
      networkEventCount: 0,
      networkFailureCount: 1,
      failedNetworkEvents: [networkEvent(503)],
    }),
    browserEvents({ policyViolations: ["forged violation summary"] }),
  ];
  for (const events of cases) {
    assert.throws(
      () => assertFinalVerificationCheckSemantics(semanticInput(events)),
      /browser|event|count|policy|invalid/i,
    );
  }
});

function semanticInput(
  events: FinalVerificationBrowserEventsFact,
  policy: Record<string, unknown> = {},
) {
  const state = { revision: REVISION, status: "" };
  const common = {
    category: "browser" as const,
    label: "browser",
    capturedAt: "2026-08-26T00:00:04.000Z",
    sessionId: "session",
    url: OBSERVED_URL,
    requestedUrl: REQUESTED_URL,
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    targetRevision: REVISION,
    startState: state,
    endState: state,
  };
  return {
    check: {
      category: "browser",
      status: "required",
      green: true,
      evidenceIds: ["snapshot", "screenshot", "events"],
      issues: [],
      facts: [
        {
          ...common,
          kind: "browser_snapshot",
          title: "Redirected fixture",
          htmlArtifactHash: "a".repeat(64),
          htmlBytes: 32,
          truncated: false,
        },
        {
          ...common,
          kind: "browser_screenshot",
          screenshotArtifactHash: "b".repeat(64),
          mediaType: "image/png",
          byteLength: 32,
        },
        events,
      ],
    },
    profile: {
      version: 1 as const,
      targetRevision: REVISION,
      inspectedPaths: ["package.json"],
      detectedSignals: [{ category: "browser" as const, source: "fixture", detail: "browser" }],
      commands: {},
      browser: { label: "browser", url: REQUESTED_URL, policy },
    },
    targetRevision: REVISION,
    workspacePath: WORKSPACE,
  };
}

function browserEvents(
  overrides: Partial<FinalVerificationBrowserEventsFact> = {},
): FinalVerificationBrowserEventsFact {
  const state = { revision: REVISION, status: "" };
  return {
    kind: "browser_events",
    category: "browser",
    label: "browser",
    capturedAt: "2026-08-26T00:00:04.000Z",
    eventsArtifactHash: "c".repeat(64),
    consoleEventCount: 0,
    consoleErrorCount: 0,
    networkEventCount: 0,
    networkFailureCount: 0,
    sessionId: "session",
    url: OBSERVED_URL,
    requestedUrl: REQUESTED_URL,
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    targetRevision: REVISION,
    startState: state,
    endState: state,
    consoleErrors: [],
    pageErrors: [],
    failedNetworkEvents: [],
    policyViolations: [],
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

function consoleEvent(type: string, text: string, source: "console" | "pageerror") {
  return { type, text, source, occurredAt: "2026-08-26T00:00:03.500Z" };
}

function networkEvent(status: number, failure?: string) {
  return {
    method: "GET",
    url: "http://127.0.0.1:4173/api",
    status,
    ...(failure ? { failure } : {}),
    occurredAt: "2026-08-26T00:00:03.500Z",
  };
}
