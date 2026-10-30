import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { annotateFailure, describeFailureChain, describeFailureWithCauses, lifecycleTrace } from "../src/lifecycle-diagnostics.js";
import { captureProcessResidue, descendantsOf } from "./support/process-residue.js";

test("failure chains name operations, system fields, aggregate members and causes, bounded and redacted", () => {
  const root = Object.assign(new Error("TerminateJobObject failed"), { code: "EACCES", errno: 5, syscall: "TerminateJobObject", pid: 4242 });
  const signal = new Error("signal transport failed", { cause: root });
  annotateFailure(signal, { operation: "backend_signal", context: "action=terminate" });
  annotateFailure(signal, { operation: "ignored-second-operation" });
  const aggregate = new AggregateError([signal, "plain string", { detail: "object" }], "cleanup failed");
  const chain = describeFailureChain(new Error("top", { cause: aggregate }));
  assert.equal(chain,
    "Error: top <- caused by AggregateError: cleanup failed [[backend_signal] Error: signal transport failed {action=terminate} " +
    "<- caused by Error(code=EACCES errno=5 syscall=TerminateJobObject pid=4242): TerminateJobObject failed; plain string; non-Error: {\"detail\":\"object\"}]");

  const cyclic = new Error("cycle") as Error & { cause?: unknown };
  cyclic.cause = cyclic;
  assert.equal(describeFailureChain(cyclic), "Error: cycle <- caused by (cycle)");
  assert.match(describeFailureChain(new Error("token sk-abcdefghijklmnopqrstuv and Bearer abc.def")), /token <redacted> and <redacted>/);
  assert.ok(describeFailureChain(new Error("x".repeat(10_000), { cause: new Error("y".repeat(10_000)) })).length <= 2_000);
  let deep: Error = new Error("bottom");
  for (let index = 0; index < 20; index += 1) deep = new Error(`level ${index}`, { cause: deep });
  assert.match(describeFailureChain(deep), /…$/);
});

test("the displayed failure keeps the plain message unless the chain adds information", () => {
  assert.equal(describeFailureWithCauses(new Error("plain")), "plain");
  assert.equal(describeFailureWithCauses("text"), "text");
  assert.equal(describeFailureWithCauses(new Error("outer", { cause: new Error("inner") })), "outer [diagnostic: Error: outer <- caused by Error: inner]");
});

test("lifecycle trace is off by default and timestamped when AIBOARD_LIFECYCLE_TRACE=1", () => {
  const writes: string[] = [];
  const original = process.stderr.write;
  const previous = process.env.AIBOARD_LIFECYCLE_TRACE;
  process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    delete process.env.AIBOARD_LIFECYCLE_TRACE;
    lifecycleTrace("process.launched", { rootPid: 1 });
    assert.deepEqual(writes, []);
    process.env.AIBOARD_LIFECYCLE_TRACE = "1";
    lifecycleTrace("process.launched", { invocationId: "inv-1", rootPid: 42, skipped: undefined, detail: "a\nb" });
    assert.equal(writes.length, 1);
    assert.match(writes[0]!, new RegExp(`^\\[aiboard-lifecycle\\] \\d{4}-\\d\\d-\\d\\dT[0-9:.]+Z pid=${process.pid} process\\.launched invocationId=inv-1 rootPid=42 detail=a b\\n$`));
  } finally {
    process.stderr.write = original;
    if (previous === undefined) delete process.env.AIBOARD_LIFECYCLE_TRACE; else process.env.AIBOARD_LIFECYCLE_TRACE = previous;
  }
});

test("teardown residue lists active handles and the live child keeping this process alive", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const residue = captureProcessResidue();
    assert.equal(residue.pid, process.pid);
    assert.ok((residue.activeResources.ProcessWrap ?? 0) >= 1, JSON.stringify(residue.activeResources));
    assert.ok(Array.isArray(residue.descendants), JSON.stringify(residue.descendants));
    assert.ok((residue.descendants as readonly { pid: number }[]).some((entry) => entry.pid === child.pid), JSON.stringify(residue.descendants));
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("close", resolve));
  }
  assert.deepEqual(descendantsOf(1, [{ pid: 2, parentPid: 1, name: "a" }, { pid: 3, parentPid: 2, name: "b" }, { pid: 4, parentPid: 9, name: "c" }]).map((entry) => entry.pid), [2, 3]);
});
