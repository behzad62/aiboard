import type { FinalVerificationCategory } from "./final-verification-contracts.js";
import type { FinalVerificationExecutionProfile } from "./final-verification-profile.js";
import type {
  FinalVerificationCommand,
  FinalVerificationFact,
} from "./final-verification-runtime.js";
import type { BrowserConsoleEvent, BrowserNetworkEvent } from "./browser-tools.js";
import { evaluateFinalVerificationBrowserPolicy } from "./final-verification-browser-policy.js";

export interface FinalVerificationCheckSemanticsInput {
  check: unknown;
  profile: FinalVerificationExecutionProfile;
  targetRevision: string;
  workspacePath: string;
}

/** One mechanical authority shared by scheduler append/replay and submission. */
export function assertFinalVerificationCheckSemantics(
  input: FinalVerificationCheckSemanticsInput,
): void {
  const check = record(input.check, "Final verification check");
  const category = categoryValue(check.category);
  const status = stringValue(check.status, `${category} status`);
  if (status !== "required" && status !== "not_applicable") {
    throw new Error(`Final verification ${category} status is invalid.`);
  }
  if (typeof check.green !== "boolean") {
    throw new Error(`Final verification ${category} green outcome is invalid.`);
  }
  if (!Array.isArray(check.facts)) {
    throw new Error(`Final verification ${category} facts are invalid.`);
  }
  const facts = check.facts;
  const issues = check.issues === undefined ? [] : check.issues;
  if (!Array.isArray(issues) || issues.some((issue) => typeof issue !== "string")) {
    throw new Error(`Final verification ${category} issues are invalid.`);
  }
  if (check.green === true && issues.length > 0) {
    throw new Error(`Green final verification ${category} cannot carry mechanical issues.`);
  }
  if (status === "not_applicable") {
    if (check.green !== true || facts.length > 0 || issues.length > 0) {
      throw new Error(`Not-applicable final verification ${category} cannot carry executable evidence.`);
    }
    const detected = input.profile.detectedSignals.some((signal) => signal.category === category);
    const specified = category === "build" || category === "tests"
      ? Boolean(input.profile.commands[category]?.length)
      : category === "runtime_smoke"
        ? Boolean(input.profile.runtimeSmoke)
        : Boolean(input.profile.browser);
    if (detected || specified) {
      throw new Error(`Not-applicable final verification ${category} conflicts with runner-inspected signals.`);
    }
    return;
  }

  if (category === "build" || category === "tests") {
    const specifications = input.profile.commands[category];
    if (!specifications?.length) {
      throw new Error(`Required final verification ${category} has no runner-inspected command specification.`);
    }
    assertCommandFacts(facts, specifications, category, input, check.green);
    return;
  }
  if (category === "runtime_smoke") {
    const specification = input.profile.runtimeSmoke;
    if (!specification) {
      throw new Error("Required final verification runtime_smoke has no runner-inspected specification.");
    }
    assertCommandFacts(facts, [specification], category, input, check.green);
    return;
  }

  const specification = input.profile.browser;
  if (!specification) {
    throw new Error("Required final verification browser has no runner-inspected specification.");
  }
  if (check.green && facts.length !== 3) {
    throw new Error("Green browser verification requires exactly snapshot, screenshot, and event facts.");
  }
  if (facts.length > 3) throw new Error("Browser verification has excess facts.");
  const expectedKinds = ["browser_snapshot", "browser_screenshot", "browser_events"] as const;
  for (const [index, fact] of facts.entries()) {
    assertFinalVerificationFactSchema(fact, category, input.targetRevision);
    const value = fact as FinalVerificationFact;
    if (value.kind !== expectedKinds[index]) {
      throw new Error(`Browser verification fact ${index} does not match the exact expected cardinality/order.`);
    }
    if (value.label !== specification.label || value.requestedUrl !== specification.url) {
      throw new Error("Browser verification fact conflicts with the runner-inspected label or requested URL.");
    }
    assertWorkspaceState(value, input.targetRevision, input.workspacePath, false);
  }
  if (facts[2] !== undefined) {
    const events = facts[2] as Record<string, unknown>;
    const evaluation = evaluateFinalVerificationBrowserPolicy({
      consoleErrors: events.consoleErrors as BrowserConsoleEvent[],
      pageErrors: events.pageErrors as BrowserConsoleEvent[],
      failedNetworkEvents: events.failedNetworkEvents as BrowserNetworkEvent[],
    }, specification.policy);
    if (!Array.isArray(events.policyViolations) ||
      events.policyViolations.some((violation) => typeof violation !== "string") ||
      !sameStrings(events.policyViolations as string[], evaluation.policyViolations)) {
      throw new Error("Final verification browser policy violations conflict with captured events and policy.");
    }
    if (events.consoleErrorCount !== evaluation.consoleErrors.length ||
      !nonNegativeInteger(events.consoleEventCount) ||
      (events.consoleEventCount as number) < evaluation.consoleErrors.length + evaluation.pageErrors.length ||
      events.networkFailureCount !== evaluation.failedNetworkEvents.length ||
      !nonNegativeInteger(events.networkEventCount) ||
      (events.networkEventCount as number) < evaluation.failedNetworkEvents.length) {
      throw new Error("Final verification browser event counts conflict with captured failures.");
    }
    if (check.green === true && evaluation.policyViolations.length > 0) {
      throw new Error("Green browser verification contains recomputed policy violations.");
    }
  }
  if (check.green) {
    const snapshot = facts[0] as Record<string, unknown>;
    const screenshot = facts[1] as Record<string, unknown>;
    const events = facts[2] as Record<string, unknown>;
    if (snapshot.truncated !== false || !positiveInteger(snapshot.htmlBytes)) {
      throw new Error("Green browser snapshot is missing or truncated.");
    }
    if (screenshot.mediaType !== "image/png" || !positiveInteger(screenshot.byteLength)) {
      throw new Error("Green browser screenshot is missing or invalid.");
    }
    if (events.timedOut !== false || events.cancelled !== false) {
      throw new Error("Green browser events contain timeout, cancellation, or policy violations.");
    }
    if (snapshot.sessionId !== screenshot.sessionId || snapshot.sessionId !== events.sessionId ||
      snapshot.url !== screenshot.url || snapshot.url !== events.url) {
      throw new Error("Green browser facts do not describe one exact browser session and observed URL.");
    }
  }
}

function assertCommandFacts(
  facts: unknown[],
  specifications: readonly FinalVerificationCommand[],
  category: "build" | "tests" | "runtime_smoke",
  input: FinalVerificationCheckSemanticsInput,
  green: unknown,
): void {
  if (green === true && facts.length !== specifications.length) {
    throw new Error(`Green final verification ${category} requires exactly ${specifications.length} command facts.`);
  }
  if (facts.length > specifications.length) {
    throw new Error(`Final verification ${category} has excess command facts.`);
  }
  for (const [index, fact] of facts.entries()) {
    assertFinalVerificationFactSchema(fact, category, input.targetRevision);
    if (fact.kind !== "command") {
      throw new Error(`Final verification ${category} requires command facts.`);
    }
    const specification = specifications[index]!;
    if (
      fact.label !== specification.label ||
      fact.executable !== specification.executable ||
      fact.command !== specification.executable ||
      !sameStrings(fact.args, specification.args)
    ) {
      throw new Error(`Final verification ${category} fact conflicts with the exact runner-inspected command.`);
    }
    assertWorkspaceState(fact, input.targetRevision, input.workspacePath, true);
    if (category === "runtime_smoke") {
      const endpoint = input.profile.runtimeSmoke?.endpoint;
      if (fact.endpoint !== endpoint) {
        throw new Error("Final verification runtime_smoke endpoint conflicts with the runner-inspected endpoint.");
      }
    }
    if (green === true) assertGreenCommand(fact, category);
  }
}

function assertGreenCommand(
  fact: Extract<FinalVerificationFact, { kind: "command" }>,
  category: "build" | "tests" | "runtime_smoke",
): void {
  if (
    fact.signal !== null || fact.timedOut || fact.cancelled || fact.outputTruncated ||
    (category === "runtime_smoke"
      ? fact.exitCode !== null && fact.exitCode !== 0
      : fact.exitCode !== 0)
  ) {
    throw new Error(`Green final verification ${category} has non-green process semantics.`);
  }
  if (category === "runtime_smoke" &&
    (fact.readinessSatisfied !== true || fact.cleanupRequested !== true || fact.cleanupSucceeded !== true)) {
    throw new Error("Green runtime_smoke lacks readiness or successful cleanup proof.");
  }
}

function assertWorkspaceState(
  fact: FinalVerificationFact,
  revision: string,
  workspacePath: string,
  command: boolean,
): void {
  if (
    fact.targetRevision !== revision || fact.startState.revision !== revision ||
    fact.endState.revision !== revision
  ) {
    throw new Error(`Final verification ${fact.category} fact crossed a revision or workspace-state boundary.`);
  }
  if (command && (fact as Extract<FinalVerificationFact, { kind: "command" }>).cwd !== workspacePath) {
    throw new Error(`Final verification ${fact.category} command ran outside the exact verification workspace.`);
  }
}

export function assertFinalVerificationFactSchema(
  fact: unknown,
  category: string,
  targetRevision: string,
): asserts fact is FinalVerificationFact {
  const value = record(fact, `Final verification ${category} fact`);
  if (value.category !== category || typeof value.kind !== "string") {
    throw new Error(`Final verification ${category} fact schema is invalid.`);
  }
  for (const key of ["label", "startedAt", "finishedAt"] as const) {
    stringValue(value[key], `${category} ${key}`);
  }
  if (value.targetRevision !== targetRevision) {
    throw new Error(`Final verification ${category} fact targets a stale revision.`);
  }
  assertRevisionState(value.startState, targetRevision, "startState");
  assertRevisionState(value.endState, targetRevision, "endState");
  if (value.kind === "command") {
    for (const key of ["command", "executable", "cwd", "stdoutArtifactHash", "stderrArtifactHash"] as const) {
      stringValue(value[key], `${category} ${key}`);
    }
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`Final verification ${category} command args are invalid.`);
    }
    if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) {
      throw new Error(`Final verification ${category} exit code is invalid.`);
    }
    if (value.signal !== null && typeof value.signal !== "string") {
      throw new Error(`Final verification ${category} signal is invalid.`);
    }
    for (const key of ["timedOut", "cancelled", "outputTruncated"] as const) {
      if (typeof value[key] !== "boolean") throw new Error(`Final verification ${category} ${key} is invalid.`);
    }
    if (value.repositoryRevision !== targetRevision) {
      throw new Error(`Final verification ${category} repository revision is invalid.`);
    }
    if (category === "runtime_smoke" &&
      (typeof value.readinessSatisfied !== "boolean" || typeof value.cleanupRequested !== "boolean" ||
        typeof value.cleanupSucceeded !== "boolean")) {
      throw new Error("Final verification runtime_smoke readiness and cleanup facts are invalid.");
    }
    return;
  }
  if (category !== "browser") throw new Error(`Final verification ${category} fact kind is invalid.`);
  stringValue(value.url, "browser url");
  stringValue(value.requestedUrl, "browser requestedUrl");
  stringValue(value.capturedAt, "browser capturedAt");
  stringValue(value.sessionId, "browser sessionId");
  if (value.kind === "browser_snapshot") {
    if (typeof value.title !== "string") throw new Error("Final verification browser title is invalid.");
    stringValue(value.htmlArtifactHash, "browser htmlArtifactHash");
    if (!nonNegativeInteger(value.htmlBytes) || typeof value.truncated !== "boolean") {
      throw new Error("Final verification browser snapshot fact is invalid.");
    }
    return;
  }
  if (value.kind === "browser_screenshot") {
    stringValue(value.screenshotArtifactHash, "browser screenshotArtifactHash");
    if (value.mediaType !== "image/png" || !nonNegativeInteger(value.byteLength)) {
      throw new Error("Final verification browser screenshot fact is invalid.");
    }
    return;
  }
  if (value.kind !== "browser_events") throw new Error("Final verification browser fact kind is invalid.");
  stringValue(value.eventsArtifactHash, "browser eventsArtifactHash");
  for (const key of ["consoleEventCount", "consoleErrorCount", "networkEventCount", "networkFailureCount"] as const) {
    if (!nonNegativeInteger(value[key])) throw new Error(`Final verification browser ${key} is invalid.`);
  }
  for (const key of ["consoleErrors", "pageErrors", "failedNetworkEvents", "policyViolations"] as const) {
    if (!Array.isArray(value[key])) throw new Error(`Final verification browser ${key} is invalid.`);
  }
  if (typeof value.timedOut !== "boolean" || typeof value.cancelled !== "boolean") {
    throw new Error("Final verification browser termination facts are invalid.");
  }
}

function assertRevisionState(value: unknown, revision: string, label: string): void {
  const state = record(value, `Final verification fact ${label}`);
  if (state.revision !== revision || typeof state.status !== "string") {
    throw new Error(`Final verification fact ${label} is invalid.`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is invalid.`);
  return value;
}

function categoryValue(value: unknown): FinalVerificationCategory {
  if (value !== "build" && value !== "tests" && value !== "runtime_smoke" && value !== "browser") {
    throw new Error(`Final verification category ${String(value)} is invalid.`);
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
