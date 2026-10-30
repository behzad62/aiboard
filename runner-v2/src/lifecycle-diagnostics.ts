// Diagnostic-only failure description for process lifecycle errors. Nothing here decides control,
// ownership, cleanup or release; it only names what failed so a CI log can be read after the fact.
//
// - `annotateFailure` tags an error with the operation that produced it (for example
//   `backend_observe`, or `backend_observe.lease_heartbeat` when the lease heartbeat failed while the
//   effect was running) and optional context. Tags live in a WeakMap: the error object is not changed.
// - `describeFailureChain` renders an error, its tags, its system fields (code, errno, syscall, pid)
//   and its `cause` / AggregateError members as one bounded line.
// - `lifecycleTrace` writes timestamped lifecycle events to stderr only when AIBOARD_LIFECYCLE_TRACE=1.

interface FailureAnnotation {
  readonly operation?: string;
  readonly context?: string;
}

const annotations = new WeakMap<object, FailureAnnotation>();
const MAX_DEPTH = 6;
const MAX_NODE_MESSAGE = 400;
const MAX_TOTAL = 2_000;
const SECRET = /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{12,}|\bBearer\s+\S+/g;

function clean(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(SECRET, "<redacted>").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Records which operation produced `error` (first annotation wins) and optional context. */
export function annotateFailure(error: unknown, annotation: FailureAnnotation): void {
  if (error === null || typeof error !== "object") return;
  try {
    const existing = annotations.get(error);
    annotations.set(error, {
      ...(existing?.operation ?? annotation.operation ? { operation: existing?.operation ?? annotation.operation } : {}),
      ...(existing?.context ?? annotation.context ? { context: existing?.context ?? annotation.context } : {}),
    });
  } catch {
    // Diagnostics never change the annotated failure's path.
  }
}

function systemFields(error: object): string {
  const fields: string[] = [];
  for (const key of ["code", "errno", "syscall", "pid", "exitCode", "signal"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") fields.push(`${key}=${clean(String(value), 80)}`);
  }
  return fields.length ? `(${fields.join(" ")})` : "";
}

function describeNode(error: unknown, depth: number, seen: Set<unknown>): string {
  if (depth > MAX_DEPTH) return "…";
  if (error === null || typeof error !== "object") return clean(String(error), MAX_NODE_MESSAGE);
  if (seen.has(error)) return "(cycle)";
  seen.add(error);
  const annotation = annotations.get(error);
  const name = error instanceof Error ? error.name : "non-Error";
  const message = error instanceof Error ? error.message : (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
  let text = `${annotation?.operation ? `[${annotation.operation}] ` : ""}${name}${systemFields(error)}: ${clean(message, MAX_NODE_MESSAGE)}`;
  if (annotation?.context) text += ` {${clean(annotation.context, MAX_NODE_MESSAGE)}}`;
  if (error instanceof AggregateError && error.errors.length) {
    text += ` [${error.errors.slice(0, 8).map((member) => describeNode(member, depth + 1, seen)).join("; ")}${error.errors.length > 8 ? `; +${error.errors.length - 8} more` : ""}]`;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) text += ` <- caused by ${describeNode(cause, depth + 1, seen)}`;
  return text;
}

/** One bounded line naming every error in the chain, outermost first. */
export function describeFailureChain(error: unknown): string {
  try {
    const text = describeNode(error, 0, new Set());
    return text.length > MAX_TOTAL ? `${text.slice(0, MAX_TOTAL - 1)}…` : text;
  } catch {
    return "(failure could not be described)";
  }
}

/** The plain message, followed by the full chain only when the chain says more than the message. */
export function describeFailureWithCauses(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const plain = error instanceof Error ? `${error.name}: ${clean(message, MAX_NODE_MESSAGE)}` : clean(message, MAX_NODE_MESSAGE);
    const chain = describeFailureChain(error);
    return chain === plain ? message : `${message} [diagnostic: ${chain}]`;
  } catch {
    return message;
  }
}

/** Off unless AIBOARD_LIFECYCLE_TRACE=1; never throws. */
export function lifecycleTrace(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  if (process.env.AIBOARD_LIFECYCLE_TRACE !== "1") return;
  try {
    const rendered = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${clean(typeof value === "string" ? value : JSON.stringify(value) ?? String(value), 300)}`)
      .join(" ");
    process.stderr.write(`[aiboard-lifecycle] ${new Date().toISOString()} pid=${process.pid} ${event}${rendered ? ` ${rendered}` : ""}\n`);
  } catch {
    // Tracing is best-effort and must never change the traced operation.
  }
}
