import type { BrowserConsoleEvent, BrowserNetworkEvent } from "./browser-tools.js";

export type FinalVerificationBrowserFailurePolicy = "fail" | "allow";

export interface FinalVerificationBrowserPolicy {
  consoleErrors?: FinalVerificationBrowserFailurePolicy;
  pageErrors?: FinalVerificationBrowserFailurePolicy;
  failedNetworkEvents?: FinalVerificationBrowserFailurePolicy;
  allowedConsoleErrorPatterns?: readonly string[];
  allowedPageErrorPatterns?: readonly string[];
  allowedNetworkFailurePatterns?: readonly string[];
}

export interface FinalVerificationCapturedBrowserFailures {
  consoleErrors: readonly BrowserConsoleEvent[];
  pageErrors: readonly BrowserConsoleEvent[];
  failedNetworkEvents: readonly BrowserNetworkEvent[];
}

export interface FinalVerificationBrowserPolicyEvaluation {
  consoleErrors: BrowserConsoleEvent[];
  pageErrors: BrowserConsoleEvent[];
  failedNetworkEvents: BrowserNetworkEvent[];
  policyViolations: string[];
}

export function captureFinalVerificationBrowserFailures(events: {
  console: readonly BrowserConsoleEvent[];
  network: readonly BrowserNetworkEvent[];
}): FinalVerificationCapturedBrowserFailures {
  const consoleEvents = events.console.map((event) => validateConsoleEvent(event));
  const networkEvents = events.network.map((event) => validateNetworkEvent(event));
  return {
    consoleErrors: consoleEvents.filter(isConsoleError),
    pageErrors: consoleEvents.filter(isPageError),
    failedNetworkEvents: networkEvents.filter(isFailedNetworkEvent),
  };
}

/** Pure policy authority shared by runtime capture and durable semantics. */
export function evaluateFinalVerificationBrowserPolicy(
  captured: FinalVerificationCapturedBrowserFailures,
  policy: FinalVerificationBrowserPolicy,
): FinalVerificationBrowserPolicyEvaluation {
  validatePolicy(policy);
  const consoleErrors = captured.consoleErrors.map((event) => {
    const validated = validateConsoleEvent(event);
    if (!isConsoleError(validated)) throw new Error("Final verification browser consoleErrors contains a non-console-error event.");
    return validated;
  });
  const pageErrors = captured.pageErrors.map((event) => {
    const validated = validateConsoleEvent(event);
    if (!isPageError(validated)) throw new Error("Final verification browser pageErrors contains a non-page-error event.");
    return validated;
  });
  const failedNetworkEvents = captured.failedNetworkEvents.map((event) => {
    const validated = validateNetworkEvent(event);
    if (!isFailedNetworkEvent(validated)) throw new Error("Final verification browser failedNetworkEvents contains a non-failure event.");
    return validated;
  });
  const policyViolations: string[] = [];
  if ((policy.consoleErrors ?? "fail") === "fail") {
    for (const event of consoleErrors) {
      if (!matchesPattern(event.text, policy.allowedConsoleErrorPatterns)) {
        policyViolations.push(`unallowed console error: ${event.text}`);
      }
    }
  }
  if ((policy.pageErrors ?? "fail") === "fail") {
    for (const event of pageErrors) {
      if (!matchesPattern(event.text, policy.allowedPageErrorPatterns)) {
        policyViolations.push(`unallowed page error: ${event.text}`);
      }
    }
  }
  if ((policy.failedNetworkEvents ?? "fail") === "fail") {
    for (const event of failedNetworkEvents) {
      const description = `${event.method} ${event.url} ${event.status ?? ""} ${event.failure ?? ""}`.trim();
      if (!matchesPattern(description, policy.allowedNetworkFailurePatterns)) {
        policyViolations.push(`unallowed network failure: ${description}`);
      }
    }
  }
  return { consoleErrors, pageErrors, failedNetworkEvents, policyViolations };
}

function isConsoleError(event: BrowserConsoleEvent): boolean {
  return event.source !== "pageerror" && event.type === "error";
}

function isPageError(event: BrowserConsoleEvent): boolean {
  return event.source === "pageerror" || event.type === "pageerror";
}

function isFailedNetworkEvent(event: BrowserNetworkEvent): boolean {
  return Boolean(event.failure) || (event.status !== undefined && event.status >= 400);
}

function validateConsoleEvent(event: unknown): BrowserConsoleEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Final verification browser console event is invalid.");
  }
  const value = event as Record<string, unknown>;
  if (typeof value.type !== "string" || !value.type.trim() ||
    typeof value.text !== "string" || typeof value.occurredAt !== "string" || !value.occurredAt.trim() ||
    (value.source !== undefined && value.source !== "console" && value.source !== "pageerror")) {
    throw new Error("Final verification browser console event is invalid.");
  }
  return {
    type: value.type,
    text: value.text,
    occurredAt: value.occurredAt,
    ...(value.source ? { source: value.source as "console" | "pageerror" } : {}),
  };
}

function validateNetworkEvent(event: unknown): BrowserNetworkEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("Final verification browser network event is invalid.");
  }
  const value = event as Record<string, unknown>;
  if (typeof value.method !== "string" || !value.method.trim() ||
    typeof value.url !== "string" || !value.url.trim() ||
    typeof value.occurredAt !== "string" || !value.occurredAt.trim() ||
    (value.status !== undefined && (!Number.isSafeInteger(value.status) || (value.status as number) < 0)) ||
    (value.failure !== undefined && (typeof value.failure !== "string" || !value.failure.trim()))) {
    throw new Error("Final verification browser network event is invalid.");
  }
  try { new URL(value.url); }
  catch { throw new Error("Final verification browser network event URL is invalid."); }
  return {
    method: value.method,
    url: value.url,
    occurredAt: value.occurredAt,
    ...(value.status !== undefined ? { status: value.status as number } : {}),
    ...(value.failure !== undefined ? { failure: value.failure as string } : {}),
  };
}

function validatePolicy(policy: FinalVerificationBrowserPolicy): void {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Final verification browser policy is invalid.");
  }
  for (const value of [policy.consoleErrors, policy.pageErrors, policy.failedNetworkEvents]) {
    if (value !== undefined && value !== "fail" && value !== "allow") {
      throw new Error("Final verification browser policy is invalid.");
    }
  }
  for (const patterns of [
    policy.allowedConsoleErrorPatterns,
    policy.allowedPageErrorPatterns,
    policy.allowedNetworkFailurePatterns,
  ]) {
    if (patterns !== undefined && (!Array.isArray(patterns) || patterns.length > 32 ||
      patterns.some((pattern) => typeof pattern !== "string" || !pattern.trim() || pattern.length > 256))) {
      throw new Error("Final verification browser policy allowlist is invalid.");
    }
  }
}

function matchesPattern(value: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some((pattern) => value.includes(pattern)) ?? false;
}
