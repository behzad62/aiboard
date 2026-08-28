import assert from "node:assert/strict";

import {
  canonicalHarnessParityContract,
  canonicalHarnessParityIdentity,
  createHarnessParityContract,
  DEEPSEEK_HARNESS_SOURCE_REVISION,
  executeParityValidatedHarnessArms,
  HarnessParityError,
} from "../lib/benchmark/robust-build/parity";
import type { HarnessParityErrorCode } from "../lib/benchmark/robust-build/parity";

type HarnessId = "deepseek-harness" | "runner-v2";

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
  version: number;
  permissions: string[];
  network: string;
}

interface MutableEnvironment {
  version: number;
  platform: string;
  architecture: string;
  clock: {
    source: string;
    deadlinePolicy: string;
  };
  dependencies: {
    policy: string;
    prefetchManifestHash: string;
  };
  workspace: string;
  state: string;
  processTree: string;
  ports: string;
}

interface MutableSource {
  revision: string;
  treeHash: string;
  dependencyLockHash: string;
}

interface MutableArm {
  harness: HarnessId;
  source: MutableSource;
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  roles: MutableRole[];
  limits: MutableLimits;
  policy: MutablePolicy;
  environment: MutableEnvironment;
  baseRepositoryHash: string;
  caseHash: string;
}

interface MutableContract {
  schemaVersion: number;
  requiredRoles: string[];
  executionOrder: HarnessId[];
  arms: Record<HarnessId, MutableArm>;
}

interface MutableAttestation extends Omit<MutableArm, "harness"> {
  schemaVersion: number;
  harness: HarnessId;
}

interface MutableLaunchRecord {
  attestation: MutableAttestation;
  callback: () => unknown | Promise<unknown>;
}

const RUNNER_V2_TEST_REVISION = "ec1ec8a110a77a0ad34a12ee60fa350583d4da2e";
const RUNNER_V2_NEXT_TEST_REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_REPOSITORY_HASH = "0123456789abcdef0123456789abcdef01234567";
const CASE_HASH = "89abcdef0123456789abcdef0123456789abcdef";
const DEEPSEEK_TREE_HASH = "1111111111111111111111111111111111111111";
const RUNNER_TREE_HASH = "2222222222222222222222222222222222222222";
const DEEPSEEK_LOCK_HASH = "3333333333333333333333333333333333333333";
const RUNNER_LOCK_HASH = "4444444444444444444444444444444444444444";
const PREFETCH_MANIFEST_HASH = "5555555555555555555555555555555555555555";

function makeContract(): MutableContract {
  const roles: MutableRole[] = [
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
  const limits: MutableLimits = {
    maxInputTokens: 40_000,
    maxOutputTokens: 8_000,
    maxModelCalls: 12,
    maxToolCalls: 30,
    maxCostUsd: 4.5,
    maxWallClockMs: 180_000,
  };
  const policy: MutablePolicy = {
    version: 1,
    permissions: ["workspace-read", "workspace-write", "run-allowlisted-command"],
    network: "dependency-only",
  };
  const environment: MutableEnvironment = {
    version: 1,
    platform: "win32",
    architecture: "x64",
    clock: {
      source: "monotonic-clock-v1",
      deadlinePolicy: "monotonic-hard-deadline",
    },
    dependencies: {
      policy: "locked-prefetched",
      prefetchManifestHash: PREFETCH_MANIFEST_HASH,
    },
    workspace: "fresh-isolated",
    state: "fresh-isolated",
    processTree: "owned-process-tree",
    ports: "exclusive-reserved",
  };

  return {
    schemaVersion: 1,
    requiredRoles: ["architect", "worker"],
    executionOrder: ["deepseek-harness", "runner-v2"],
    arms: {
      "deepseek-harness": {
        harness: "deepseek-harness",
        source: {
          revision: DEEPSEEK_HARNESS_SOURCE_REVISION,
          treeHash: DEEPSEEK_TREE_HASH,
          dependencyLockHash: DEEPSEEK_LOCK_HASH,
        },
        providerId: "openai",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
        roles: clone(roles),
        limits: clone(limits),
        policy: clone(policy),
        environment: clone(environment),
        baseRepositoryHash: BASE_REPOSITORY_HASH,
        caseHash: CASE_HASH,
      },
      "runner-v2": {
        harness: "runner-v2",
        source: {
          revision: RUNNER_V2_TEST_REVISION,
          treeHash: RUNNER_TREE_HASH,
          dependencyLockHash: RUNNER_LOCK_HASH,
        },
        providerId: "openai",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
        roles: clone(roles),
        limits: clone(limits),
        policy: clone(policy),
        environment: clone(environment),
        baseRepositoryHash: BASE_REPOSITORY_HASH,
        caseHash: CASE_HASH,
      },
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeAttestation(arm: MutableArm): MutableAttestation {
  return {
    schemaVersion: 1,
    harness: arm.harness,
    source: clone(arm.source),
    providerId: arm.providerId,
    modelId: arm.modelId,
    reasoningEffort: arm.reasoningEffort,
    roles: clone(arm.roles),
    limits: clone(arm.limits),
    policy: clone(arm.policy),
    environment: clone(arm.environment),
    baseRepositoryHash: arm.baseRepositoryHash,
    caseHash: arm.caseHash,
  };
}

function makeLaunchRecords(
  contract: MutableContract,
  callbacks: Partial<Record<HarnessId, () => unknown | Promise<unknown>>> = {}
): Record<HarnessId, MutableLaunchRecord> {
  return {
    "deepseek-harness": {
      attestation: makeAttestation(contract.arms["deepseek-harness"]),
      callback: callbacks["deepseek-harness"] ?? (() => "deepseek"),
    },
    "runner-v2": {
      attestation: makeAttestation(contract.arms["runner-v2"]),
      callback: callbacks["runner-v2"] ?? (() => "runner"),
    },
  };
}

function expectParityError(
  operation: () => unknown,
  code: HarnessParityErrorCode
): HarnessParityError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HarnessParityError, `expected ${code} parity error`);
  assert.equal(caught.code, code);
  return caught;
}

function expectNoModelStarts(
  contract: MutableContract,
  mutate: (records: Record<HarnessId, MutableLaunchRecord>) => void,
  code: HarnessParityErrorCode
): void {
  const starts: HarnessId[] = [];
  const records = makeLaunchRecords(contract, {
    "deepseek-harness": () => starts.push("deepseek-harness"),
    "runner-v2": () => starts.push("runner-v2"),
  });
  mutate(records);
  expectParityError(() => executeParityValidatedHarnessArms(contract, records), code);
  assert.deepEqual(starts, []);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

{
  const fixture = makeContract();
  const canonical = canonicalHarnessParityContract(fixture);
  assert.equal(canonical.arms["deepseek-harness"].source.revision, DEEPSEEK_HARNESS_SOURCE_REVISION);
  assert.equal(canonical.arms["runner-v2"].source.revision, RUNNER_V2_TEST_REVISION);
  assert.ok(Object.isFrozen(canonical));
  assert.ok(Object.isFrozen(canonical.arms["deepseek-harness"].source));
  assert.ok(Object.isFrozen(canonical.arms["runner-v2"].environment.dependencies));
  fixture.arms["runner-v2"].limits.maxModelCalls = 99;
  assert.equal(canonical.arms["runner-v2"].limits.maxModelCalls, 12);
}

{
  const fixture = makeContract();
  fixture.arms["runner-v2"].reasoningEffort = "medium";
  expectParityError(() => createHarnessParityContract(fixture), "parity_mismatch");
}

{
  const fixture = makeContract();
  fixture.arms["runner-v2"].limits.maxToolCalls -= 1;
  expectParityError(() => createHarnessParityContract(fixture), "parity_mismatch");
}

for (const mutate of [
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].providerId = "other-provider";
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].modelId = "other-model";
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].roles[0].modelId = "other-role-model";
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].policy.network = "none";
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].policy.permissions = ["workspace-read"];
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].environment.architecture = "arm64";
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].baseRepositoryHash =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].caseHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  },
]) {
  const fixture = makeContract();
  mutate(fixture);
  expectParityError(() => createHarnessParityContract(fixture), "parity_mismatch");
}

for (const limitKey of [
  "maxInputTokens",
  "maxOutputTokens",
  "maxModelCalls",
  "maxToolCalls",
  "maxCostUsd",
  "maxWallClockMs",
] as const) {
  const fixture = makeContract();
  fixture.arms["runner-v2"].limits[limitKey] += 1;
  expectParityError(() => createHarnessParityContract(fixture), "parity_mismatch");
}

{
  const fixture = makeContract();
  delete (fixture.arms["deepseek-harness"].limits as unknown as Record<string, unknown>)
    .maxCostUsd;
  delete (fixture.arms["runner-v2"].limits as unknown as Record<string, unknown>).maxCostUsd;
  expectNoModelStarts(fixture, () => undefined, "missing_value");
}

{
  const fixture = makeContract();
  fixture.executionOrder = ["deepseek-harness", "deepseek-harness"];
  expectParityError(() => createHarnessParityContract(fixture), "invalid_execution_order");
}

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].source.revision = RUNNER_V2_TEST_REVISION;
  expectParityError(() => createHarnessParityContract(fixture), "invalid_source_revision");
}

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].roles[0].available = false;
  fixture.arms["runner-v2"].roles[0].available = false;
  expectNoModelStarts(fixture, () => undefined, "missing_value");
}

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].roles.pop();
  fixture.arms["runner-v2"].roles.pop();
  expectNoModelStarts(fixture, () => undefined, "missing_value");
}

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].policy.network = "internet";
  fixture.arms["runner-v2"].policy.network = "internet";
  expectNoModelStarts(fixture, () => undefined, "invalid_contract");
}

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].policy.permissions = ["workspace-read", "shell"];
  fixture.arms["runner-v2"].policy.permissions = ["workspace-read", "shell"];
  expectNoModelStarts(fixture, () => undefined, "invalid_contract");
}

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].environment.platform = "plan9";
  fixture.arms["runner-v2"].environment.platform = "plan9";
  expectNoModelStarts(fixture, () => undefined, "invalid_contract");
}

{
  const fixture = makeContract();
  expectNoModelStarts(
    fixture,
    (records) => {
      records["runner-v2"].attestation.policy.network = "none";
    },
    "attestation_mismatch"
  );
}

{
  const fixture = makeContract();
  expectNoModelStarts(
    fixture,
    (records) => {
      delete (records["runner-v2"].attestation.environment as unknown as Record<string, unknown>)
        .ports;
    },
    "missing_value"
  );
}

{
  const fixture = makeContract();
  expectNoModelStarts(
    fixture,
    (records) => {
      records["runner-v2"].attestation.environment.architecture = "arm64";
    },
    "attestation_mismatch"
  );
}

for (const sourceField of ["revision", "treeHash", "dependencyLockHash"] as const) {
  const fixture = makeContract();
  expectNoModelStarts(
    fixture,
    (records) => {
      records["runner-v2"].attestation.source[sourceField] =
        sourceField === "revision"
          ? RUNNER_V2_NEXT_TEST_REVISION
          : "6666666666666666666666666666666666666666";
    },
    "attestation_mismatch"
  );
}

{
  const current = makeContract();
  const next = makeContract();
  next.arms["runner-v2"].source.revision = RUNNER_V2_NEXT_TEST_REVISION;
  const currentIdentity = canonicalHarnessParityIdentity(current);
  const nextIdentity = canonicalHarnessParityIdentity(next);
  assert.notEqual(nextIdentity, currentIdentity);
  const result = await executeParityValidatedHarnessArms(next, makeLaunchRecords(next));
  assert.deepEqual(
    result.map((entry) => entry.result),
    ["deepseek", "runner"]
  );
}

{
  const canonical = makeContract();
  const reordered = makeContract();
  reordered.requiredRoles.reverse();
  for (const arm of Object.values(reordered.arms)) {
    arm.roles.reverse();
    arm.policy.permissions.reverse();
  }
  assert.equal(canonicalHarnessParityIdentity(reordered), canonicalHarnessParityIdentity(canonical));

  const reversedOrder = makeContract();
  reversedOrder.executionOrder = ["runner-v2", "deepseek-harness"];
  assert.notEqual(
    canonicalHarnessParityIdentity(reversedOrder),
    canonicalHarnessParityIdentity(canonical)
  );
}

{
  const fixture = makeContract();
  const starts: HarnessId[] = [];
  const pendingDeepseek = deferred<string>();
  const pair = executeParityValidatedHarnessArms(
    fixture,
    makeLaunchRecords(fixture, {
      "deepseek-harness": () => {
        starts.push("deepseek-harness");
        return pendingDeepseek.promise;
      },
      "runner-v2": () => {
        starts.push("runner-v2");
        return "runner";
      },
    })
  );
  assert.deepEqual(starts, ["deepseek-harness"]);
  await Promise.resolve();
  assert.deepEqual(starts, ["deepseek-harness"]);
  pendingDeepseek.resolve("deepseek");
  const result = await pair;
  assert.deepEqual(starts, ["deepseek-harness", "runner-v2"]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.ok(Object.isFrozen(result[0].attestation));
  assert.deepEqual(
    result.map((entry) => entry.result),
    ["deepseek", "runner"]
  );
}

{
  const fixture = makeContract();
  const starts: HarnessId[] = [];
  const pair = executeParityValidatedHarnessArms(
    fixture,
    makeLaunchRecords(fixture, {
      "deepseek-harness": () => {
        starts.push("deepseek-harness");
        return Promise.reject(new Error("deepseek failed"));
      },
      "runner-v2": () => {
        starts.push("runner-v2");
        return "runner";
      },
    })
  );
  await assert.rejects(pair, /deepseek failed/);
  assert.deepEqual(starts, ["deepseek-harness"]);
}

{
  const fixture = makeContract();
  let getterReads = 0;
  const starts: HarnessId[] = [];
  const records = makeLaunchRecords(fixture, {
    "deepseek-harness": () => starts.push("deepseek-harness"),
    "runner-v2": () => starts.push("runner-v2"),
  });
  const arm = fixture.arms["deepseek-harness"] as unknown as Record<string, unknown>;
  const source = arm.source;
  Object.defineProperty(arm, "source", {
    enumerable: true,
    get() {
      getterReads += 1;
      return source;
    },
  });
  expectParityError(() => executeParityValidatedHarnessArms(fixture, records), "invalid_contract");
  assert.equal(getterReads, 0);
  assert.deepEqual(starts, []);
}

{
  const fixture = makeContract();
  const starts: HarnessId[] = [];
  const records = makeLaunchRecords(fixture, {
    "deepseek-harness": () => starts.push("deepseek-harness"),
    "runner-v2": () => starts.push("runner-v2"),
  });
  delete (records as unknown as Record<string, unknown>)["runner-v2"];
  expectParityError(() => executeParityValidatedHarnessArms(fixture, records), "invalid_callbacks");
  assert.deepEqual(starts, []);
}

{
  const fixture = makeContract();
  let getterReads = 0;
  const starts: HarnessId[] = [];
  const records = makeLaunchRecords(fixture, {
    "deepseek-harness": () => starts.push("deepseek-harness"),
    "runner-v2": () => starts.push("runner-v2"),
  });
  const permissions = fixture.arms["deepseek-harness"].policy.permissions;
  Object.defineProperty(permissions, "0", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "workspace-read";
    },
  });
  expectParityError(() => executeParityValidatedHarnessArms(fixture, records), "invalid_contract");
  assert.equal(getterReads, 0);
  assert.deepEqual(starts, []);
}

{
  const fixture = makeContract();
  let getterReads = 0;
  const starts: HarnessId[] = [];
  const records = makeLaunchRecords(fixture, {
    "deepseek-harness": () => starts.push("deepseek-harness"),
    "runner-v2": () => starts.push("runner-v2"),
  });
  const record = records["runner-v2"] as unknown as Record<string, unknown>;
  const attestation = record.attestation;
  Object.defineProperty(record, "attestation", {
    enumerable: true,
    get() {
      getterReads += 1;
      return attestation;
    },
  });
  expectParityError(() => executeParityValidatedHarnessArms(fixture, records), "invalid_callbacks");
  assert.equal(getterReads, 0);
  assert.deepEqual(starts, []);
}

{
  const fixture = makeContract();
  Object.defineProperty(fixture, "hidden", {
    enumerable: false,
    value: "must not be ignored",
  });
  expectParityError(() => createHarnessParityContract(fixture), "invalid_contract");
}

{
  const fixture = makeContract();
  const secret = Symbol("secret");
  Object.defineProperty(fixture.arms["runner-v2"], secret, {
    enumerable: true,
    value: "must not be ignored",
  });
  expectParityError(() => createHarnessParityContract(fixture), "invalid_contract");
}

console.log("robust-build parity contract tests passed");
