/* Task B3.5 contract pin (run: npx tsx scripts/test-certified-run-error-status.mts)
 *
 * statusForRunError (run-engine.ts) synthesizes a BenchmarkAttemptV2 status
 * from a raw run-error message. Before this fix it only consulted
 * isProviderFailureMessage's narrower pattern before falling through to
 * invalid_harness, so a fatal provider/account error whose message lacked
 * that pattern's keywords (e.g. "insufficient funds", "billing problem", a
 * bare "credits depleted" with no 429) misclassified as invalid_harness --
 * reading as "our harness broke" instead of "the provider's fault". This
 * pins the full classification table, including the fix cases and
 * regression guards for budget/abort/genuine-harness precedence.
 */
import { statusForRunError } from "../lib/benchmark/certified/run-engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function checkStatus(message: string, expected: ReturnType<typeof statusForRunError>): void {
  const actual = statusForRunError(message);
  check(`"${message}" -> ${expected}`, actual === expected, { message, expected, actual });
}

// --- abort / cancel precedence ---
checkStatus("Certified run aborted by user.", "aborted_user");
checkStatus("Run cancelled", "aborted_user");

// --- existing isProviderFailureMessage coverage (unchanged) ---
checkStatus("ChatGPT request failed: 503", "provider_unavailable");
checkStatus(
  "[429 ] Your prepayment credits are depleted.",
  "provider_unavailable"
); // 429 keyword; the real Gemini case

// --- THE FIX: fatal provider/account errors with no isProviderFailureMessage
// keyword match, now caught by the classifyProviderFailure fallback ---
checkStatus(
  "Your prepayment credits are depleted.",
  "provider_unavailable"
); // no 429 -- would have been invalid_harness before this fix
checkStatus("insufficient funds on your account", "provider_unavailable");
checkStatus(
  "There is a billing problem with your account",
  "provider_unavailable"
);
checkStatus(
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 12857d04-3d48-4f42-821c-7ef7eba4efc3 in your message.",
  "provider_unavailable"
);

// --- REGRESSION GUARDS: the fix must NOT reclassify budget or genuine-harness
// errors. classifyProviderFailure is only consulted AFTER the budget branch,
// so budget messages (which classify as "other" under classifyProviderFailure)
// stay failed_budget, and messages matching neither classifier stay
// invalid_harness. ---
checkStatus(
  "Certified budget exceeded during model-call streaming: wall-clock time exceeded maxWallClockMs 600000.",
  "failed_budget"
);
checkStatus("token limit exceeded", "failed_budget");
checkStatus(
  "Certified budget exceeded during model-call preflight: projected USD 6.00 exceeded maxUsd 5.",
  "failed_budget"
);
checkStatus(
  "Unexpected internal harness assertion failed",
  "invalid_harness"
); // a genuine harness bug still reads as invalid_harness

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);

process.exit(failures === 0 ? 0 : 1);
