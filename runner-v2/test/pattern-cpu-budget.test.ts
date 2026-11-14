// The CPU-time bound on user regexes (pattern-cpu-budget.ts): a busy host that only delays an evaluation never fails
// it; a pattern that really burns its CPU budget does, and so does a host that starves it up to the wall ceiling.
import assert from "node:assert/strict";
import test from "node:test";
import { Script, createContext } from "node:vm";

import { PATTERN_WALL_CEILING_MS, runPatternWithCpuBudget } from "../src/pattern-cpu-budget.js";

const timeout = () => Object.assign(new Error("Script execution timed out."), { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" });

/** A script whose first `starved` runs are interrupted before using any CPU (the host kept the thread waiting). */
function starvedScript(starved: number) {
  const timeouts: number[] = [];
  const script = {
    runInContext: (_context: unknown, options: { timeout: number }) => {
      timeouts.push(options.timeout);
      if (timeouts.length <= starved) throw timeout();
      return "matched";
    },
  } as unknown as Script;
  return { script, timeouts };
}

test("an evaluation the host only delayed is run again with twice the timeout and succeeds", () => {
  const { script, timeouts } = starvedScript(3);
  assert.deepEqual(runPatternWithCpuBudget(script, createContext({}), 50), { ok: true, value: "matched" });
  assert.deepEqual(timeouts, [50, 100, 200, 200], "no attempt gets more than 4x the budget");
});

test("a caller's lower wall ceiling bounds the retries", () => {
  const { script, timeouts } = starvedScript(Number.POSITIVE_INFINITY);
  assert.deepEqual(runPatternWithCpuBudget(script, createContext({}), 50, 300), { ok: false, reason: "wall" });
  assert.deepEqual(timeouts, [50, 100, 150]);
});

test("a host that starves every attempt fails closed at the wall ceiling, never later", () => {
  const { script, timeouts } = starvedScript(Number.POSITIVE_INFINITY);
  assert.deepEqual(runPatternWithCpuBudget(script, createContext({}), 50), { ok: false, reason: "wall" });
  assert.equal(timeouts.reduce((sum, ms) => sum + ms, 0), PATTERN_WALL_CEILING_MS, "the timeouts granted add up to the ceiling");
});

test("a pattern that burns its CPU budget in one attempt fails at once", () => {
  const context = createContext({ re: /a*a*a*a*a*a*b/u, s: "a".repeat(64) });
  const cpuBefore = process.threadCpuUsage();
  assert.deepEqual(runPatternWithCpuBudget(new Script("re.exec(s)"), context, 50), { ok: false, reason: "cpu" });
  const used = process.threadCpuUsage(cpuBefore);
  assert.ok((used.user + used.system) / 1_000 < 50 * 8, "it stopped near its budget, not after the pattern's seconds");
});

test("an ordinary pattern returns its result", () => {
  const context = createContext({ re: /ready on port (\d+)/u, s: `${"x".repeat(4000)}ready on port 3000` });
  const result = runPatternWithCpuBudget<RegExpExecArray | null>(new Script("re.exec(s)"), context, 50);
  assert.ok(result.ok);
  assert.equal(result.value?.[1], "3000");
});

test("other script errors are thrown as they are", () => {
  assert.throws(() => runPatternWithCpuBudget(new Script("missing.call()"), createContext({}), 50), /missing is not defined/);
});
