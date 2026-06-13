/** Token usage estimator checks (run: npx tsx scripts/test-token-usage.mts) */
import { estimateModelCallUsage } from "../lib/client/token-usage";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const usage = estimateModelCallUsage({
  messages: [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Patch src/query.ts without rewriting it." },
  ],
  output: "Done. Applied a small patch.",
  maxTokens: 8192,
});

check("usage is explicitly estimated", usage.estimated === true, usage);
check("input tokens are counted", usage.inputTokens > 0, usage);
check("output tokens are counted", usage.outputTokens > 0, usage);
check(
  "total is input plus output",
  usage.totalTokens === usage.inputTokens + usage.outputTokens,
  usage
);
check("max token budget is preserved", usage.maxTokens === 8192, usage);

const bigger = estimateModelCallUsage({
  messages: [{ role: "user", content: "x".repeat(4000) }],
  output: "",
  maxTokens: 1000,
});

check("larger prompts estimate more tokens", bigger.inputTokens > usage.inputTokens, {
  usage,
  bigger,
});

process.exit(failed === 0 ? 0 : 1);
