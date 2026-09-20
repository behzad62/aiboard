import assert from "node:assert/strict";
import test from "node:test";

import {
  freezeExecutionLifecycleRequirements,
  lifecycleRequirementsDigest,
  resolveRequiredLifecycleScope,
} from "../src/execution-lifecycle-policy.js";

test("ordinary full requests process_group; non-full and explicit requirements request contained_workload", () => {
  assert.equal(resolveRequiredLifecycleScope({ permissionProfile: "full" }), "process_group");
  assert.equal(resolveRequiredLifecycleScope({ permissionProfile: "project" }), "contained_workload");
  assert.equal(resolveRequiredLifecycleScope({ permissionProfile: "guarded" }), "contained_workload");
  assert.equal(resolveRequiredLifecycleScope({
    permissionProfile: "full",
    lifecycleRequirements: { requireCompleteCleanup: true },
  }), "contained_workload");
  assert.equal(resolveRequiredLifecycleScope({
    permissionProfile: "full",
    lifecycleRequirements: { knownUnavoidableDetachment: true },
  }), "contained_workload");
  assert.equal(resolveRequiredLifecycleScope({
    permissionProfile: "full",
    lifecycleRequirements: { requireCompleteCleanup: false, knownUnavoidableDetachment: false },
  }), "process_group");
});

test("lifecycle requirement freeze and digest treat omission as distinct from empty flags", () => {
  assert.equal(freezeExecutionLifecycleRequirements(undefined), undefined);
  assert.equal(freezeExecutionLifecycleRequirements({}), undefined);
  assert.deepEqual(freezeExecutionLifecycleRequirements({ requireCompleteCleanup: true }), {
    requireCompleteCleanup: true,
  });
  assert.notEqual(
    lifecycleRequirementsDigest(undefined),
    lifecycleRequirementsDigest({ requireCompleteCleanup: true }),
  );
});
