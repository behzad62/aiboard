const NONRECOVERABLE_GAME_AI_ERROR_PATTERNS = [
  /\baborted\b/i,
  /\bunknown provider\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\binvalid api key\b/i,
  /\bmissing api key\b/i,
  /\bkey limit\b/i,
  /\bquota\b/i,
  /\brate[ _-]?limit\b/i,
  /\b429\b/i,
  /\b401\b/i,
  /\b402\b/i,
  /\b403\b/i,
  /\bresource[ _-]?exhausted\b/i,
  /\bspending cap\b/i,
  /\bmonthly spending\b/i,
  /\bbilling\b/i,
  /\bpayment required\b/i,
];

export function isNonrecoverableGameAIError(error: string): boolean {
  return NONRECOVERABLE_GAME_AI_ERROR_PATTERNS.some((pattern) =>
    pattern.test(error)
  );
}

export function isRecoverableGameAIError(error: string): boolean {
  return !isNonrecoverableGameAIError(error);
}
