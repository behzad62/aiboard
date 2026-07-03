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
