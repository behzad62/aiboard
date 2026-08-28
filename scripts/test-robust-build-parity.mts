/* Robust Build harness-parity checks (run: npx tsx scripts/test-robust-build-parity.mts) */
import assert from "node:assert/strict";
import {
  beginParityValidatedHarnessArms,
  canonicalHarnessParityIdentity,
  createHarnessParityContract,
  DEEPSEEK_HARNESS_SOURCE_REVISION,
  HarnessParityError,
  RUNNER_V2_PRODUCT_SOURCE_REVISION,
} from "../lib/benchmark/robust-build/parity";
import type { HarnessParityArmCallbacks } from "../lib/benchmark/robust-build/types";

function expectParityError(
  assertion: () => unknown,
  code: HarnessParityError["code"],
  message: string
): void {
  assert.throws(
    assertion,
    (error) => error instanceof HarnessParityError && error.code === code,
    message
  );
}

interface MutableRole {
  role: string;
  available: boolean;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
}

interface MutableLimits {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxCostUsd: number;
  maxWallClockMs: number;
}

interface MutablePolicy {
  permissions: string[];
  network: string;
}

interface MutableArm {
  harness: string;
  sourceRevision: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  roles: MutableRole[];
  limits: MutableLimits;
  policy: MutablePolicy;
  baseRepositoryHash: string;
  caseHash: string;
}

interface MutableParityFixture {
  schemaVersion: number;
  requiredRoles: string[];
  executionOrder: string[];
  arms: Record<string, MutableArm>;
}

function parityFixture(): MutableParityFixture {
  const roles = [
    {
      role: "architect",
      available: true,
      providerId: "openai",
      modelId: "gpt-5.6",
      reasoningEffort: "high",
    },
    {
      role: "worker",
      available: true,
      providerId: "openai",
      modelId: "gpt-5.6",
      reasoningEffort: "high",
    },
  ];
  const limits = {
    maxInputTokens: 12_000,
    maxOutputTokens: 4_000,
    maxModelCalls: 8,
    maxToolCalls: 24,
    maxCostUsd: 1.5,
    maxWallClockMs: 300_000,
  };
  const policy = {
    permissions: ["workspace-read", "workspace-write", "run-allowlisted-command"],
    network: "dependency-only",
  };
  return {
    schemaVersion: 1,
    requiredRoles: ["architect", "worker"],
    executionOrder: ["deepseek-harness", "runner-v2"],
    arms: {
      "deepseek-harness": {
        harness: "deepseek-harness",
        sourceRevision: DEEPSEEK_HARNESS_SOURCE_REVISION,
        providerId: "openai",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
        roles,
        limits,
        policy,
        baseRepositoryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        caseHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      "runner-v2": {
        harness: "runner-v2",
        sourceRevision: RUNNER_V2_PRODUCT_SOURCE_REVISION,
        providerId: "openai",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
        roles: structuredClone(roles),
        limits: structuredClone(limits),
        policy: structuredClone(policy),
        baseRepositoryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        caseHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
  };
}

const unequalEffort = structuredClone(parityFixture()) as {
  arms: Record<string, { reasoningEffort: string }>;
};
unequalEffort.arms["runner-v2"]!.reasoningEffort = "low";

expectParityError(
  () => createHarnessParityContract(unequalEffort),
  "parity_mismatch",
  "a pair whose arm-level reasoning effort differs must be rejected before it can run"
);

console.log("PASS reasoning-effort parity guard");

const unequalBudget = structuredClone(parityFixture()) as {
  arms: Record<string, { limits: { maxToolCalls: number } }>;
};
unequalBudget.arms["runner-v2"]!.limits.maxToolCalls += 1;

expectParityError(
  () => createHarnessParityContract(unequalBudget),
  "parity_mismatch",
  "a one-call budget difference must be rejected before either arm can run"
);

console.log("PASS one-call budget parity guard");

const unequalProvider = structuredClone(parityFixture()) as {
  arms: Record<string, { providerId: string }>;
};
unequalProvider.arms["runner-v2"]!.providerId = "anthropic";

expectParityError(
  () => createHarnessParityContract(unequalProvider),
  "parity_mismatch",
  "a provider identity difference must be rejected before either arm can run"
);

console.log("PASS provider identity parity guard");

const unequalModel = structuredClone(parityFixture()) as {
  arms: Record<string, { modelId: string }>;
};
unequalModel.arms["runner-v2"]!.modelId = "claude-opus-5";

expectParityError(
  () => createHarnessParityContract(unequalModel),
  "parity_mismatch",
  "a model identity difference must be rejected before either arm can run"
);

console.log("PASS model identity parity guard");

const unequalRoleAvailability = structuredClone(parityFixture()) as {
  arms: Record<string, { roles: Array<{ available: boolean }> }>;
};
unequalRoleAvailability.arms["runner-v2"]!.roles[1]!.available = false;

expectParityError(
  () => createHarnessParityContract(unequalRoleAvailability),
  "parity_mismatch",
  "a role availability difference must be rejected before either arm can run"
);

console.log("PASS role availability parity guard");

const unequalRoleMapping = structuredClone(parityFixture()) as {
  arms: Record<string, { roles: Array<{ modelId: string }> }>;
};
unequalRoleMapping.arms["runner-v2"]!.roles[0]!.modelId = "gpt-5.6-mini";

expectParityError(
  () => createHarnessParityContract(unequalRoleMapping),
  "parity_mismatch",
  "a per-role model mapping difference must be rejected before either arm can run"
);

console.log("PASS role mapping parity guard");

const missingRequiredRole = structuredClone(parityFixture()) as {
  arms: Record<string, { roles: unknown[] }>;
};
for (const arm of Object.values(missingRequiredRole.arms)) arm.roles.pop();

expectParityError(
  () => createHarnessParityContract(missingRequiredRole),
  "missing_value",
  "a role omitted from both arms must fail closed rather than silently shrink the parity roster"
);

console.log("PASS complete role roster guard");

const unequalNetworkPolicy = structuredClone(parityFixture()) as {
  arms: Record<string, { policy: { network: string } }>;
};
unequalNetworkPolicy.arms["runner-v2"]!.policy.network = "none";

expectParityError(
  () => createHarnessParityContract(unequalNetworkPolicy),
  "parity_mismatch",
  "a network policy difference must be rejected before either arm can run"
);

console.log("PASS network policy parity guard");

const unequalPermissions = structuredClone(parityFixture()) as {
  arms: Record<string, { policy: { permissions: string[] } }>;
};
unequalPermissions.arms["runner-v2"]!.policy.permissions.pop();

expectParityError(
  () => createHarnessParityContract(unequalPermissions),
  "parity_mismatch",
  "a permission policy difference must be rejected before either arm can run"
);

console.log("PASS permission policy parity guard");

const unequalBaseRepository = structuredClone(parityFixture()) as {
  arms: Record<string, { baseRepositoryHash: string }>;
};
unequalBaseRepository.arms["runner-v2"]!.baseRepositoryHash =
  "cccccccccccccccccccccccccccccccccccccccc";

expectParityError(
  () => createHarnessParityContract(unequalBaseRepository),
  "parity_mismatch",
  "a base-repository hash difference must be rejected before either arm can run"
);

console.log("PASS base repository hash parity guard");

const unequalCaseHash = structuredClone(parityFixture()) as {
  arms: Record<string, { caseHash: string }>;
};
unequalCaseHash.arms["runner-v2"]!.caseHash =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

expectParityError(
  () => createHarnessParityContract(unequalCaseHash),
  "parity_mismatch",
  "a case hash difference must be rejected before either arm can run"
);

console.log("PASS case hash parity guard");

const wrongRunnerSource = structuredClone(parityFixture()) as {
  arms: Record<string, { sourceRevision: string }>;
};
wrongRunnerSource.arms["runner-v2"]!.sourceRevision =
  "0000000000000000000000000000000000000000";

expectParityError(
  () => createHarnessParityContract(wrongRunnerSource),
  "invalid_source_revision",
  "Runner V2 must be pinned to the exact product revision"
);

console.log("PASS Runner source pin guard");

const wrongDeepSeekSource = structuredClone(parityFixture()) as {
  arms: Record<string, { sourceRevision: string }>;
};
wrongDeepSeekSource.arms["deepseek-harness"]!.sourceRevision =
  "0000000000000000000000000000000000000000";

expectParityError(
  () => createHarnessParityContract(wrongDeepSeekSource),
  "invalid_source_revision",
  "DeepSeek Harness must be pinned to its exact immutable source revision"
);

console.log("PASS DeepSeek source pin guard");

const malformedExecutionOrder = structuredClone(parityFixture()) as {
  executionOrder: string[];
};
malformedExecutionOrder.executionOrder = ["runner-v2", "runner-v2"];

expectParityError(
  () => createHarnessParityContract(malformedExecutionOrder),
  "invalid_execution_order",
  "a paired execution order must name each harness exactly once"
);

console.log("PASS paired execution order guard");

const missingCostLimit = structuredClone(parityFixture());
for (const arm of Object.values(missingCostLimit.arms)) {
  delete (arm.limits as Partial<MutableLimits>).maxCostUsd;
}

expectParityError(
  () => createHarnessParityContract(missingCostLimit),
  "missing_value",
  "an unreported parity limit must fail closed even when both arms omit it"
);

console.log("PASS missing parity value guard");

const frozenContract = createHarnessParityContract(parityFixture());
assert.equal(Object.isFrozen(frozenContract), true, "the contract itself must be immutable");
assert.equal(Object.isFrozen(frozenContract.arms), true, "the arm record must be immutable");
assert.equal(
  Object.isFrozen(frozenContract.arms["deepseek-harness"]!.roles),
  true,
  "nested role mappings must be immutable"
);

console.log("PASS immutable contract guard");

const defensiveInput = parityFixture();
const defensiveContract = createHarnessParityContract(defensiveInput);
defensiveInput.arms["deepseek-harness"]!.roles[0]!.modelId = "tampered-after-validation";
defensiveInput.arms["runner-v2"]!.policy.permissions.push("network-admin");
assert.equal(
  defensiveContract.arms["deepseek-harness"]!.roles[0]!.modelId,
  "gpt-5.6",
  "the returned contract must not retain mutable role references"
);
assert.deepEqual(
  defensiveContract.arms["runner-v2"]!.policy.permissions,
  ["run-allowlisted-command", "workspace-read", "workspace-write"],
  "the returned contract must not retain mutable permission references"
);

console.log("PASS defensive contract copy guard");

expectParityError(
  () => createHarnessParityContract({}),
  "missing_value",
  "a malformed contract must fail closed"
);

const abbreviatedDeepSeekSource = parityFixture();
abbreviatedDeepSeekSource.arms["deepseek-harness"]!.sourceRevision = "b150a55";
expectParityError(
  () => createHarnessParityContract(abbreviatedDeepSeekSource),
  "invalid_source_revision",
  "an abbreviated source pin must fail closed"
);

console.log("PASS malformed and abbreviated source guards");

const reorderedInput = parityFixture();
reorderedInput.requiredRoles.reverse();
for (const arm of Object.values(reorderedInput.arms)) {
  arm.roles.reverse();
  arm.policy.permissions.reverse();
}
assert.equal(
  canonicalHarnessParityIdentity(reorderedInput),
  canonicalHarnessParityIdentity(parityFixture()),
  "canonical identity must ignore ordering within role and permission mappings"
);

const reversedOrderInput = parityFixture();
reversedOrderInput.executionOrder = ["runner-v2", "deepseek-harness"];
assert.notEqual(
  canonicalHarnessParityIdentity(reversedOrderInput),
  canonicalHarnessParityIdentity(parityFixture()),
  "canonical identity must preserve the paired execution order"
);

console.log("PASS deterministic canonical identity guard");

const blockedCallbacks: string[] = [];
expectParityError(
  () =>
    beginParityValidatedHarnessArms(unequalEffort, {
      "deepseek-harness": ({ harness }) => {
        blockedCallbacks.push(harness);
        return harness;
      },
      "runner-v2": ({ harness }) => {
        blockedCallbacks.push(harness);
        return harness;
      },
    }),
  "parity_mismatch",
  "an unequal contract must be rejected before either arm callback begins"
);
assert.deepEqual(blockedCallbacks, [], "invalid parity must not begin any arm callback");

const incompleteCallbacks: string[] = [];
const incompleteCallbackRecord: Partial<HarnessParityArmCallbacks<string>> = {
  "deepseek-harness": ({ harness }) => {
    incompleteCallbacks.push(harness);
    return harness;
  },
};
expectParityError(
  () =>
    beginParityValidatedHarnessArms(
      parityFixture(),
      incompleteCallbackRecord as HarnessParityArmCallbacks<string>
    ),
  "invalid_callbacks",
  "missing arm callbacks must be rejected before the provided callback begins"
);
assert.deepEqual(incompleteCallbacks, [], "an incomplete callback record must not start an arm");

const executionEvents: string[] = [];
const launched = beginParityValidatedHarnessArms(reversedOrderInput, {
  "deepseek-harness": ({ harness, contract }) => {
    assert.equal(Object.isFrozen(contract), true, "callbacks receive the frozen contract");
    executionEvents.push(harness);
    return `started:${harness}`;
  },
  "runner-v2": ({ harness, contract }) => {
    assert.equal(Object.isFrozen(contract), true, "callbacks receive the frozen contract");
    executionEvents.push(harness);
    return `started:${harness}`;
  },
});
assert.deepEqual(executionEvents, ["runner-v2", "deepseek-harness"]);
assert.deepEqual(
  launched.map((entry) => entry.harness),
  ["runner-v2", "deepseek-harness"],
  "valid callbacks must begin in the declared paired order"
);
assert.equal(Object.isFrozen(launched), true, "launch records must be immutable");
assert.equal(Object.isFrozen(launched[0]!), true, "each launch record must be immutable");

console.log("PASS synchronous callback preflight and paired launch order guards");
