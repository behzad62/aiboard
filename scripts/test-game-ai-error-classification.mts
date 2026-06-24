import {
  isNonrecoverableGameAIError,
  isRecoverableGameAIError,
} from "../lib/games/core/ai-errors";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  }
}

const googleSpendCapError =
  "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse: [429 ] Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap. Learn more at https://ai.google.dev/gemini-api/docs/billing#project-spend-caps.";

assert(
  isNonrecoverableGameAIError(googleSpendCapError),
  "Google spending-cap 429 errors should stop game AI instead of using fallback moves."
);

assert(
  isNonrecoverableGameAIError("AI request failed: RESOURCE_EXHAUSTED"),
  "Google RESOURCE_EXHAUSTED errors should be nonrecoverable."
);

assert(
  isNonrecoverableGameAIError("AI request failed: 429 rate limit exceeded"),
  "Rate-limit 429 errors should be nonrecoverable."
);

assert(
  isNonrecoverableGameAIError("AI request failed: 401 Unauthorized invalid API key"),
  "Authentication failures should be nonrecoverable."
);

assert(
  isRecoverableGameAIError("Failed to parse AI response after multiple attempts"),
  "Parse failures should remain recoverable so AI-vs-AI games can use legal fallback moves."
);

assert(
  isRecoverableGameAIError("Illegal Codenames guess: word is already revealed"),
  "Illegal model actions should remain recoverable."
);

assert(
  isRecoverableGameAIError("AI request failed: Internal server error"),
  "Transient provider 500-style errors should remain recoverable for AI-vs-AI continuity."
);

if (process.exitCode) process.exit(process.exitCode);
console.log("PASS game AI error classification");
