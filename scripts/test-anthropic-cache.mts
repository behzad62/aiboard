/** Anthropic cache_control breakpoint cap (run: npx tsx scripts/test-anthropic-cache.mts) */
import { anthropicCacheBreakpointIndices } from "../lib/providers/anthropic";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

type Role = "user" | "assistant";
const conv = (turns: number): Role[] => {
  // The shape the Build engine sends: user, then (assistant, user) tool rounds.
  const roles: Role[] = ["user"];
  for (let i = 0; i < turns; i++) roles.push("assistant", "user");
  return roles;
};

// The exact failing case: a multi-turn review loop. Must stay ≤ 4 (Anthropic cap).
for (const turns of [0, 1, 2, 3, 5, 10, 40]) {
  const roles = conv(turns);
  const idx = anthropicCacheBreakpointIndices(roles);
  check(
    `≤4 breakpoints for a ${roles.length}-message conversation`,
    idx.size <= 4,
    { messages: roles.length, breakpoints: [...idx] }
  );
  check(
    `last message is always a breakpoint (${roles.length} msgs)`,
    idx.has(roles.length - 1)
  );
  check(
    `first user message is a breakpoint (${roles.length} msgs)`,
    idx.has(0)
  );
}

// Panel-engine shape: a single user message → exactly one breakpoint.
{
  const idx = anthropicCacheBreakpointIndices(["user"]);
  check("single user message → 1 breakpoint", idx.size === 1 && idx.has(0));
}

// Empty (defensive) → no breakpoints, no crash.
check("empty conversation → no breakpoints", anthropicCacheBreakpointIndices([]).size === 0);

// A conversation that opens with an assistant turn (defensive): still ≤4 and
// includes the last index.
{
  const idx = anthropicCacheBreakpointIndices(["assistant", "user", "assistant"]);
  check("assistant-first conversation stays bounded", idx.size <= 4 && idx.has(2));
}

console.log(failed === 0 ? "\nAll cache-breakpoint checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
