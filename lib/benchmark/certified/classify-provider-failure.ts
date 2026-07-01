const PROVIDER_FAILURE_PATTERN =
  /provider|api key|unauthorized|rate.?limit|quota|429|502|503|timed?\s?out|timeout/;

export function isProviderFailureMessage(message: string): boolean {
  return PROVIDER_FAILURE_PATTERN.test(message.toLowerCase());
}
