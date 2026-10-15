import assert from "node:assert/strict";
import test from "node:test";
import { assertContractTaskRevisionAllowed } from "../src/delivery-acceptance.js";

test("a refused contract change tells the Architect the valid ways forward", () => {
  const refuse = (patch: Parameters<typeof assertContractTaskRevisionAllowed>[0]["patch"]) =>
    assert.throws(
      () => assertContractTaskRevisionAllowed({ taskId: "p7-baseline", patch, contract: { dependencies: ["a"] } }),
      (error: Error) =>
        /contract (fields|dependencies) change only through a new ready plan revision/.test(error.message) &&
        /revise only this task's objective/.test(error.message) &&
        /revise_planning_plan/.test(error.message) &&
        /Do not resend this change unchanged/.test(error.message),
    );
  refuse({ acceptanceCriteria: [{ id: "c1", text: "changed" }] });
  refuse({ dependencies: ["b"] });
  assert.doesNotThrow(() => assertContractTaskRevisionAllowed({ taskId: "p7-baseline", patch: { dependencies: ["a"] }, contract: { dependencies: ["a"] } }));
});
