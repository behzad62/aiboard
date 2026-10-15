import type { Page, Request, Response } from "@playwright/test";

type Fact = Readonly<{ sequence: number; elapsedMs: number; phase: string; requestId?: number; method?: string; route?: string; status?: number; errorKind?: string }>;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError", "URIError", "EvalError", "AggregateError"]);
const NETWORK_ERRORS = new Set(["net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_CLOSED", "net::ERR_TIMED_OUT", "net::ERR_NETWORK_CHANGED", "net::ERR_EMPTY_RESPONSE"]);
const STATIC_ROUTES = new Set(["/v2", "/v2/health", "/v2/builds", "/v2/runs", "/v2/provider-configs"]);
const RUN_SUFFIXES = new Set(["", "/build", "/build/events", "/build/usage", "/build/observability", "/build/transcript", "/build/files", "/build/context-manifests", "/build/planning-readiness", "/build/planning-export", "/build/planning-schedule", "/build/plan-start", "/permissions", "/events", "/commands"]);

/** Passive browser events only; no interception, fetch, body/header reads or native authority. */
export function attachPlanningHttpDiagnostic(page: Page, runnerUrl: string, runId: string, now = () => performance.now()) {
 const origin = new URL(runnerUrl).origin;
 const runPath = "/v2/runs/" + encodeURIComponent(runId);
 const start = now();
 const facts: Fact[] = [];
 const failures: string[] = [];
 const ids = new WeakMap<Request, number>();
 const detachments: (() => unknown)[] = [];
 let sequence = 0, nextId = 0, overflow = 0, failureCount = 0, lastElapsed = 0, detached = false;
 function safely(phase: string, operation: () => void) {
  try { operation(); } catch { failureCount += 1; if (failures.length < 32) failures.push(phase); }
 }
 function record(fact: Omit<Fact, "sequence" | "elapsedMs">) {
  const elapsedMs = now() - start;
  if (!Number.isFinite(elapsedMs) || elapsedMs < lastElapsed) throw new Error("Invalid diagnostic clock");
  lastElapsed = elapsedMs;
  sequence += 1;
  if (facts.length === 512) { overflow += 1; return; }
  facts.push(Object.freeze({ sequence, elapsedMs, ...fact }));
 }
 function admitted(request: Request) {
  const url = new URL(request.url());
  if (url.origin !== origin || (url.pathname !== "/v2" && !url.pathname.startsWith("/v2/"))) return undefined;
  let route = STATIC_ROUTES.has(url.pathname) ? url.pathname : "/v2/<other>";
  if (url.pathname.startsWith(runPath)) {
   const suffix = url.pathname.slice(runPath.length);
   if (RUN_SUFFIXES.has(suffix)) route = "/v2/runs/:run" + suffix;
  }
  let requestId = ids.get(request);
  if (requestId === undefined) { requestId = ++nextId; ids.set(request, requestId); }
  const method = request.method();
  return { requestId, route, method: METHODS.has(method) ? method : "other" };
 }
 const onRequest = (request: Request) => safely("request", () => { const value = admitted(request); if (value) record({ phase: "request", ...value }); });
 const onResponse = (response: Response) => safely("response", () => {
  const value = admitted(response.request()); if (!value) return;
  const status = response.status();
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Invalid diagnostic status");
  record({ phase: "response", ...value, status });
 });
 const onFinished = (request: Request) => safely("requestfinished", () => { const value = admitted(request); if (value) record({ phase: "requestfinished", ...value }); });
 const onFailed = (request: Request) => safely("requestfailed", () => {
  const value = admitted(request); if (!value) return;
  const error = request.failure()?.errorText;
  record({ phase: "requestfailed", ...value, errorKind: error && NETWORK_ERRORS.has(error) ? error : "other" });
 });
 const onPageError = (error: Error) => safely("pageerror", () => record({ phase: "pageerror", errorKind: ERROR_NAMES.has(error.name) ? error.name : "other" }));
 function register(phase: string, attach: () => unknown, detach: () => unknown) {
  safely("register:" + phase, () => { detachments.push(detach); attach(); });
 }
 register("request", () => page.on("request", onRequest), () => page.off("request", onRequest));
 register("response", () => page.on("response", onResponse), () => page.off("response", onResponse));
 register("requestfinished", () => page.on("requestfinished", onFinished), () => page.off("requestfinished", onFinished));
 register("requestfailed", () => page.on("requestfailed", onFailed), () => page.off("requestfailed", onFailed));
 register("pageerror", () => page.on("pageerror", onPageError), () => page.off("pageerror", onPageError));
 return {
  snapshot: () => Object.freeze({ scope: "Browser fixture-origin /v2 transfers only; page errors are uncorrelated categories; not Node fetch/apply/settlement proof", complete: overflow === 0 && failureCount === 0, overflow, failureCount, failures: Object.freeze([...failures]), facts: Object.freeze(facts.map(fact => Object.freeze({ ...fact }))) }),
  detach: () => { if (detached) return; detached = true; for (const detach of detachments) safely("detach", () => { detach(); }); },
  assertComplete: () => { if (overflow || failureCount) throw new Error(`Planning HTTP diagnostic incomplete: ${overflow} dropped events; ${failureCount} capture failures.`); },
 };
}
