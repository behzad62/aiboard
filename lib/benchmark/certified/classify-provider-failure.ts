const PROVIDER_FAILURE_PATTERN =
  /provider|api key|unauthorized|rate.?limit|quota|429|502|503|timed?\s?out|timeout/;

export function isProviderFailureMessage(message: string): boolean {
  return PROVIDER_FAILURE_PATTERN.test(message.toLowerCase());
}

export type ProviderFailureClass = "transient" | "fatal" | "other";

// Fatal patterns win over transient ones: a quota/billing 429 must not be
// retried (every retry burns nothing but time — the account is out of funds),
// while a rate-limit 429 or any 5xx/timeout usually clears on its own.
const FATAL_PATTERN =
  /credits? (are )?depleted|prepayment|billing|quota exceeded|insufficient (funds|quota|credit)|payment required|api key|unauthorized|forbidden|invalid.*key|model.*not.*(found|exist)/i;
const TRANSIENT_PATTERN =
  /timed?\s?out|timeout|too many requests|rate.?limit|429|500|502|503|504|overloaded|server error|unavailable|network|fetch failed|econn|socket|empty response/i;

export function classifyProviderFailure(message: string): ProviderFailureClass {
  if (FATAL_PATTERN.test(message)) return "fatal";
  if (TRANSIENT_PATTERN.test(message)) return "transient";
  return "other";
}

/**
 * Structural type guard for CertifiedProviderError that survives the CJS/ESM
 * module boundary. `instanceof` is unreliable across it: a .mts/ESM caller and
 * a .ts/CJS module can each hold a DISTINCT CertifiedProviderError class object
 * (tsx interop loads model-call.ts twice), so `instanceof` returns false for a
 * genuinely-typed error. We match on the stable `name` tag + a valid
 * `classification` instead. Same-module throw+catch (the retry loop in
 * model-call.ts) may keep using `instanceof` — it never crosses a boundary.
 */
export function isCertifiedProviderError(
  error: unknown
): error is { name: "CertifiedProviderError"; message: string; classification: ProviderFailureClass } {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; classification?: unknown };
  return (
    e.name === "CertifiedProviderError" &&
    (e.classification === "transient" || e.classification === "fatal" || e.classification === "other")
  );
}

export function isTransientProviderError(error: unknown): boolean {
  return isCertifiedProviderError(error) && error.classification === "transient";
}
