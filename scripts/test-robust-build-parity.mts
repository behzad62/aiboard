import assert from "node:assert/strict";

import {
  canonicalHarnessParityContract,
  canonicalHarnessParityIdentity,
  createTrustedHarnessParityAuthority,
  createHarnessParityContract,
  DEEPSEEK_HARNESS_SOURCE_REVISION,
  executePreparedHarnessParityPair,
  HarnessParityCleanupError,
  HarnessParityError,
  prepareHarnessParityPair,
  releasePreparedHarnessParityPair,
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

interface PreparationInput {
  harness: HarnessId;
}

interface MutableLease {
  observedFacts: MutableArm;
  revalidate: () => MutableArm | Promise<MutableArm>;
  launch: () => unknown | Promise<unknown>;
  release: () => void | Promise<void>;
}

type LeaseResult = MutableLease | Promise<MutableLease>;

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

function makeLease(
  observedFacts: MutableArm,
  options: Partial<{
    revalidate: () => MutableArm | Promise<MutableArm>;
    launch: () => unknown | Promise<unknown>;
    release: () => void | Promise<void>;
  }> = {}
): MutableLease {
  return {
    observedFacts: clone(observedFacts),
    revalidate: options.revalidate ?? (() => clone(observedFacts)),
    launch: options.launch ?? (() => observedFacts.harness),
    release: options.release ?? (() => undefined),
  };
}

function makeAuthority(
  leases: Record<HarnessId, LeaseResult>,
  events: string[] = []
): unknown {
  return createTrustedHarnessParityAuthority({
    prepare: ({ harness }: PreparationInput) => {
      events.push(`prepare:${harness}`);
      return leases[harness];
    },
  });
}

function preparePair(
  contract: MutableContract,
  leases: Record<HarnessId, LeaseResult>,
  events: string[] = []
): Promise<unknown> {
  return prepareHarnessParityPair(contract, makeAuthority(leases, events));
}

function leasesFor(
  contract: MutableContract,
  options: Partial<Record<HarnessId, Partial<Parameters<typeof makeLease>[1]>>> = {}
): Record<HarnessId, MutableLease> {
  return {
    "deepseek-harness": makeLease(
      contract.arms["deepseek-harness"],
      options["deepseek-harness"]
    ),
    "runner-v2": makeLease(contract.arms["runner-v2"], options["runner-v2"]),
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

async function expectRejectedParityError(
  operation: () => Promise<unknown>,
  code: HarnessParityErrorCode
): Promise<HarnessParityError> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HarnessParityError, `expected ${code} parity error`);
  assert.equal(caught.code, code);
  return caught;
}

function cleanupEvidence(error: HarnessParityCleanupError): {
  readonly cleanupFailures?: readonly Readonly<{
    harness: HarnessId;
    error: unknown;
  }>[];
  readonly recoveryPair?: unknown;
} {
  return error;
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

// Canonical contract and all original parity dimensions remain sealed.
{
  const fixture = makeContract();
  const canonical = canonicalHarnessParityContract(fixture);
  assert.equal(canonical.arms["deepseek-harness"].source.revision, DEEPSEEK_HARNESS_SOURCE_REVISION);
  assert.equal(canonical.arms["runner-v2"].source.revision, RUNNER_V2_TEST_REVISION);
  assert.ok(Object.isFrozen(canonical));
  assert.ok(Object.isFrozen(canonical.arms["deepseek-harness"].source));
  fixture.arms["runner-v2"].limits.maxModelCalls = 99;
  assert.equal(canonical.arms["runner-v2"].limits.maxModelCalls, 12);

  const nextRunner = makeContract();
  nextRunner.arms["runner-v2"].source.revision = RUNNER_V2_NEXT_TEST_REVISION;
  assert.notEqual(canonicalHarnessParityIdentity(nextRunner), canonicalHarnessParityIdentity(makeContract()));

  const reordered = makeContract();
  reordered.requiredRoles.reverse();
  for (const arm of Object.values(reordered.arms)) {
    arm.roles.reverse();
    arm.policy.permissions.reverse();
  }
  assert.equal(
    canonicalHarnessParityIdentity(reordered),
    canonicalHarnessParityIdentity(makeContract())
  );
  const reversedExecutionOrder = makeContract();
  reversedExecutionOrder.executionOrder = ["runner-v2", "deepseek-harness"];
  assert.notEqual(
    canonicalHarnessParityIdentity(reversedExecutionOrder),
    canonicalHarnessParityIdentity(makeContract())
  );
}

for (const mutate of [
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].reasoningEffort = "medium";
  },
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
    fixture.arms["runner-v2"].limits.maxToolCalls += 1;
  },
  (fixture: MutableContract) => {
    fixture.arms["runner-v2"].policy.network = "none";
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

{
  const fixture = makeContract();
  fixture.arms["deepseek-harness"].roles[0].available = false;
  fixture.arms["runner-v2"].roles[0].available = false;
  expectParityError(() => createHarnessParityContract(fixture), "missing_value");
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

for (const [mutate, code] of [
  [
    (fixture: MutableContract) => {
      delete (fixture.arms["runner-v2"].limits as unknown as Record<string, unknown>).maxToolCalls;
    },
    "missing_value",
  ],
  [
    (fixture: MutableContract) => {
      delete (fixture.arms["runner-v2"].environment as unknown as Record<string, unknown>).ports;
    },
    "missing_value",
  ],
  [
    (fixture: MutableContract) => {
      fixture.arms["deepseek-harness"].policy.network = "internet";
      fixture.arms["runner-v2"].policy.network = "internet";
    },
    "invalid_contract",
  ],
] as const) {
  const fixture = makeContract();
  const events: string[] = [];
  mutate(fixture);
  expectParityError(
    () => preparePair(fixture, leasesFor(makeContract()), events),
    code
  );
  assert.deepEqual(events, []);
}

// Equal-but-unsafe arm values are not a valid sealed execution environment.
{
  const fixture = makeContract();
  for (const harness of ["deepseek-harness", "runner-v2"] as const) {
    fixture.arms[harness].environment.dependencies.policy = "unlocked-or-unprefetched";
    fixture.arms[harness].environment.workspace = "shared-or-reused";
    fixture.arms[harness].environment.state = "shared-or-reused";
    fixture.arms[harness].environment.processTree = "unowned-process-tree";
    fixture.arms[harness].environment.ports = "shared-or-unreserved";
  }
  const events: string[] = [];
  expectParityError(
    () => preparePair(fixture, leasesFor(makeContract()), events),
    "invalid_contract"
  );
  assert.deepEqual(events, []);
}

{
  const fixture = makeContract();
  let getterReads = 0;
  const arm = fixture.arms["deepseek-harness"] as unknown as Record<string, unknown>;
  const source = arm.source;
  Object.defineProperty(arm, "source", {
    enumerable: true,
    get() {
      getterReads += 1;
      return source;
    },
  });
  expectParityError(() => createHarnessParityContract(fixture), "invalid_contract");
  assert.equal(getterReads, 0);
}

for (const addUnsafeProperty of [
  (fixture: MutableContract) => {
    Object.defineProperty(fixture.arms["runner-v2"], "hidden-extra", {
      enumerable: false,
      value: true,
    });
  },
  (fixture: MutableContract) => {
    Object.defineProperty(fixture.arms["runner-v2"], Symbol("unexpected"), {
      enumerable: true,
      value: true,
    });
  },
]) {
  const fixture = makeContract();
  const events: string[] = [];
  addUnsafeProperty(fixture);
  expectParityError(
    () => preparePair(fixture, leasesFor(makeContract()), events),
    "invalid_contract"
  );
  assert.deepEqual(events, []);
}

// An opaque, module-issued prepared pair is the only execution capability.
{
  const fixture = makeContract();
  const pair = await preparePair(fixture, leasesFor(fixture));
  const fabricated = structuredClone(pair);
  expectParityError(
    () => executePreparedHarnessParityPair(fabricated),
    "invalid_prepared_pair"
  );
  const result = await executePreparedHarnessParityPair(pair);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.ok(Object.isFrozen(result[0].observedFacts));
  assert.ok(Object.isFrozen(result[0].observedFacts.source));
  assert.deepEqual(
    result.map((entry) => entry.result),
    ["deepseek-harness", "runner-v2"]
  );
}

{
  const fixture = makeContract();
  const launches: HarnessId[] = [];
  expectParityError(
    () =>
      prepareHarnessParityPair(fixture, {
        prepare: () => {
          launches.push("deepseek-harness");
          return makeLease(fixture.arms["deepseek-harness"]);
        },
      }),
    "invalid_authority"
  );
  assert.deepEqual(launches, []);
}

{
  const fixture = makeContract();
  let getterReads = 0;
  const authority = {} as Record<string, unknown>;
  Object.defineProperty(authority, "prepare", {
    enumerable: true,
    get() {
      getterReads += 1;
      return () => makeLease(fixture.arms["deepseek-harness"]);
    },
  });
  expectParityError(() => createTrustedHarnessParityAuthority(authority), "invalid_authority");
  assert.equal(getterReads, 0);
}

{
  const fixture = makeContract();
  const launches: HarnessId[] = [];
  let getterReads = 0;
  const rawLease = makeLease(fixture.arms["deepseek-harness"], {
    launch: () => launches.push("deepseek-harness"),
  }) as unknown as Record<string, unknown>;
  const launch = rawLease.launch;
  Object.defineProperty(rawLease, "launch", {
    enumerable: true,
    get() {
      getterReads += 1;
      return launch;
    },
  });
  const authority = createTrustedHarnessParityAuthority({
    prepare: () => rawLease,
  });
  await expectRejectedParityError(
    () => prepareHarnessParityPair(fixture, authority),
    "invalid_preparation"
  );
  assert.equal(getterReads, 0);
  assert.deepEqual(launches, []);
}

// Independently observed preparation facts must match the sealed contract.
for (const mutateObservedRunner of [
  (observed: MutableArm) => {
    observed.source.revision = RUNNER_V2_NEXT_TEST_REVISION;
  },
  (observed: MutableArm) => {
    observed.source.treeHash = "6666666666666666666666666666666666666666";
  },
  (observed: MutableArm) => {
    observed.source.dependencyLockHash = "7777777777777777777777777777777777777777";
  },
  (observed: MutableArm) => {
    observed.policy.network = "none";
  },
  (observed: MutableArm) => {
    observed.policy.permissions = ["workspace-read"];
  },
  (observed: MutableArm) => {
    observed.environment.dependencies.policy = "unlocked-or-unprefetched";
  },
  (observed: MutableArm) => {
    observed.environment.workspace = "shared-or-reused";
  },
  (observed: MutableArm) => {
    observed.environment.state = "shared-or-reused";
  },
  (observed: MutableArm) => {
    observed.environment.processTree = "unowned-process-tree";
  },
  (observed: MutableArm) => {
    observed.environment.ports = "shared-or-unreserved";
  },
]) {
  const fixture = makeContract();
  const launches: HarnessId[] = [];
  const releases: HarnessId[] = [];
  const observedRunner = clone(fixture.arms["runner-v2"]);
  mutateObservedRunner(observedRunner);
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      launch: () => launches.push("deepseek-harness"),
      release: () => {
        releases.push("deepseek-harness");
      },
    },
    "runner-v2": {
      launch: () => launches.push("runner-v2"),
      release: () => {
        releases.push("runner-v2");
      },
    },
  });
  leases["runner-v2"].observedFacts = observedRunner;
  await expectRejectedParityError(
    () => preparePair(fixture, leases),
    "observed_fact_mismatch"
  );
  assert.deepEqual(launches, []);
  assert.deepEqual(releases, ["runner-v2", "deepseek-harness"]);
}

// Both trusted preparations must settle before the first trusted launch begins.
{
  const fixture = makeContract();
  const events: string[] = [];
  const pendingDeepseek = deferred<MutableLease>();
  const pendingRunner = deferred<MutableLease>();
  const deepseekLease = makeLease(fixture.arms["deepseek-harness"], {
    launch: () => events.push("launch:deepseek-harness"),
  });
  const runnerLease = makeLease(fixture.arms["runner-v2"], {
    launch: () => events.push("launch:runner-v2"),
  });
  const pairPromise = preparePair(
    fixture,
    {
      "deepseek-harness": pendingDeepseek.promise,
      "runner-v2": pendingRunner.promise,
    },
    events
  );
  assert.deepEqual(events, ["prepare:deepseek-harness"]);
  pendingDeepseek.resolve(deepseekLease);
  await Promise.resolve();
  assert.deepEqual(events, ["prepare:deepseek-harness", "prepare:runner-v2"]);
  assert.equal(events.some((event) => event.startsWith("launch:")), false);
  pendingRunner.resolve(runnerLease);
  const pair = await pairPromise;
  assert.equal(events.some((event) => event.startsWith("launch:")), false);
  await executePreparedHarnessParityPair(pair);
  assert.deepEqual(events, [
    "prepare:deepseek-harness",
    "prepare:runner-v2",
    "launch:deepseek-harness",
    "launch:runner-v2",
  ]);
}

// A post-first-arm revalidation catches an invalidated second lease before launch.
{
  const fixture = makeContract();
  const launches: HarnessId[] = [];
  const releases: string[] = [];
  let runnerFacts = clone(fixture.arms["runner-v2"]);
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      launch: () => {
        launches.push("deepseek-harness");
        runnerFacts = clone(runnerFacts);
        runnerFacts.source.dependencyLockHash = "8888888888888888888888888888888888888888";
        return "deepseek";
      },
      release: () => {
        releases.push("release:deepseek-harness");
      },
    },
    "runner-v2": {
      revalidate: () => runnerFacts,
      launch: () => {
        launches.push("runner-v2");
        return "runner";
      },
      release: () => {
        releases.push("release:runner-v2");
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  await expectRejectedParityError(
    () => executePreparedHarnessParityPair(pair),
    "seal_validation_failed"
  );
  assert.deepEqual(launches, ["deepseek-harness"]);
  assert.deepEqual(releases, ["release:runner-v2", "release:deepseek-harness"]);
}

// A prepared pair is an owned lease until it is executed or explicitly released.
{
  const fixture = makeContract();
  const events: string[] = [];
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      release: () => {
        events.push("release:deepseek-harness");
      },
    },
    "runner-v2": {
      release: () => {
        events.push("release:runner-v2");
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  await releasePreparedHarnessParityPair(pair);
  assert.deepEqual(events, ["release:runner-v2", "release:deepseek-harness"]);
  expectParityError(() => releasePreparedHarnessParityPair(pair), "invalid_prepared_pair");
  expectParityError(() => executePreparedHarnessParityPair(pair), "invalid_prepared_pair");
}

{
  const fixture = makeContract();
  const events: string[] = [];
  let runnerReleaseAttempts = 0;
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      release: () => {
        events.push("release:deepseek-harness");
      },
    },
    "runner-v2": {
      release: () => {
        events.push("release:runner-v2");
        if (runnerReleaseAttempts === 0) {
          runnerReleaseAttempts += 1;
          throw new Error("runner cancel cleanup failed");
        }
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  await assert.rejects(
    async () => releasePreparedHarnessParityPair(pair),
    (error) =>
      error instanceof HarnessParityCleanupError &&
      error.code === "cleanup_failed" &&
      error.primaryError === undefined &&
      error.cleanupErrors.length === 1
  );
  assert.deepEqual(events, ["release:runner-v2", "release:deepseek-harness"]);
  await releasePreparedHarnessParityPair(pair);
  assert.deepEqual(events, [
    "release:runner-v2",
    "release:deepseek-harness",
    "release:runner-v2",
  ]);
}

// Preparation and launch failures release every acquired lease in reverse order.
{
  const fixture = makeContract();
  const events: string[] = [];
  const deepseekLease = makeLease(fixture.arms["deepseek-harness"], {
    release: () => {
      events.push("release:deepseek-harness");
    },
  });
  const authority = createTrustedHarnessParityAuthority({
    prepare: ({ harness }: PreparationInput): LeaseResult => {
      events.push(`prepare:${harness}`);
      if (harness === "deepseek-harness") return deepseekLease;
      throw new Error("runner preparation failed");
    },
  });
  await assert.rejects(
    async () => prepareHarnessParityPair(fixture, authority),
    /runner preparation failed/
  );
  assert.deepEqual(events, ["prepare:deepseek-harness", "prepare:runner-v2", "release:deepseek-harness"]);
}

// A valid provisional release handle survives malformed second-arm lease facts.
{
  const fixture = makeContract();
  const events: string[] = [];
  const deepseekLease = makeLease(fixture.arms["deepseek-harness"], {
    release: () => {
      events.push("release:deepseek-harness");
    },
  });
  const malformedRunnerLease = {
    observedFacts: {},
    revalidate: () => clone(fixture.arms["runner-v2"]),
    launch: () => {
      events.push("launch:runner-v2");
      return "runner";
    },
    release: () => {
      events.push("release:runner-v2");
    },
  };
  const authority = createTrustedHarnessParityAuthority({
    prepare: ({ harness }: PreparationInput) => {
      events.push(`prepare:${harness}`);
      return harness === "deepseek-harness" ? deepseekLease : malformedRunnerLease;
    },
  });
  await assert.rejects(
    async () => prepareHarnessParityPair(fixture, authority),
    (error) => error instanceof HarnessParityError && error.code === "missing_value"
  );
  assert.deepEqual(events, [
    "prepare:deepseek-harness",
    "prepare:runner-v2",
    "release:runner-v2",
    "release:deepseek-harness",
  ]);
}

// Failed preparation rollback exposes an opaque cleanup-only retry capability.
{
  const fixture = makeContract();
  const events: string[] = [];
  const primaryError = new Error("runner preparation failed");
  const releaseError = new Error("deepseek rollback release failed");
  let releaseAttempts = 0;
  const deepseekLease = makeLease(fixture.arms["deepseek-harness"], {
    release: () => {
      events.push("release:deepseek-harness");
      if (releaseAttempts === 0) {
        releaseAttempts += 1;
        throw releaseError;
      }
    },
  });
  const authority = createTrustedHarnessParityAuthority({
    prepare: ({ harness }: PreparationInput) => {
      events.push(`prepare:${harness}`);
      if (harness === "deepseek-harness") return deepseekLease;
      throw primaryError;
    },
  });
  let caught: unknown;
  try {
    await prepareHarnessParityPair(fixture, authority);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HarnessParityCleanupError);
  assert.equal(caught.primaryError, primaryError);
  const initialEvidence = cleanupEvidence(caught);
  assert.deepEqual(initialEvidence.cleanupFailures, [
    { harness: "deepseek-harness", error: releaseError },
  ]);
  assert.ok(Object.isFrozen(initialEvidence.cleanupFailures));
  assert.ok(Object.isFrozen(initialEvidence.cleanupFailures?.[0]));
  assert.ok(initialEvidence.recoveryPair);
  const recoveryPair = initialEvidence.recoveryPair;
  expectParityError(
    () => executePreparedHarnessParityPair(recoveryPair),
    "invalid_prepared_pair"
  );
  expectParityError(
    () => executePreparedHarnessParityPair(structuredClone(recoveryPair)),
    "invalid_prepared_pair"
  );
  expectParityError(
    () => releasePreparedHarnessParityPair(structuredClone(recoveryPair)),
    "invalid_prepared_pair"
  );
  await releasePreparedHarnessParityPair(recoveryPair);
  assert.deepEqual(events, [
    "prepare:deepseek-harness",
    "prepare:runner-v2",
    "release:deepseek-harness",
    "release:deepseek-harness",
  ]);
  expectParityError(() => releasePreparedHarnessParityPair(recoveryPair), "invalid_prepared_pair");
}

// Repeated rollback failures keep only failed owners and preserve evidence.
{
  const fixture = makeContract();
  const events: string[] = [];
  const releaseError = new Error("deepseek rollback release failed");
  let deepseekReleaseAttempts = 0;
  const deepseekLease = makeLease(fixture.arms["deepseek-harness"], {
    release: () => {
      events.push("release:deepseek-harness");
      if (deepseekReleaseAttempts < 2) {
        deepseekReleaseAttempts += 1;
        throw releaseError;
      }
    },
  });
  const malformedRunnerLease = {
    observedFacts: {},
    revalidate: () => clone(fixture.arms["runner-v2"]),
    launch: () => "runner",
    release: () => {
      events.push("release:runner-v2");
    },
  };
  const authority = createTrustedHarnessParityAuthority({
    prepare: ({ harness }: PreparationInput) =>
      harness === "deepseek-harness" ? deepseekLease : malformedRunnerLease,
  });
  let initial: unknown;
  try {
    await prepareHarnessParityPair(fixture, authority);
  } catch (error) {
    initial = error;
  }
  assert.ok(initial instanceof HarnessParityCleanupError);
  const initialEvidence = cleanupEvidence(initial);
  assert.ok(initialEvidence.recoveryPair);
  const recoveryPair = initialEvidence.recoveryPair;
  let retry: unknown;
  try {
    await releasePreparedHarnessParityPair(recoveryPair);
  } catch (error) {
    retry = error;
  }
  assert.ok(retry instanceof HarnessParityCleanupError);
  assert.equal(retry.primaryError, initial.primaryError);
  const retryEvidence = cleanupEvidence(retry);
  assert.equal(retryEvidence.recoveryPair, recoveryPair);
  assert.deepEqual(
    retryEvidence.cleanupFailures?.map((failure) => failure.harness),
    ["deepseek-harness", "deepseek-harness"]
  );
  assert.ok(Object.isFrozen(retryEvidence.cleanupFailures));
  assert.ok(Object.isFrozen(retryEvidence.cleanupFailures?.[1]));
  await releasePreparedHarnessParityPair(recoveryPair);
  assert.deepEqual(events, [
    "release:runner-v2",
    "release:deepseek-harness",
    "release:deepseek-harness",
    "release:deepseek-harness",
  ]);
}

{
  const fixture = makeContract();
  const events: string[] = [];
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      launch: () => Promise.reject(new Error("deepseek launch failed")),
      release: () => {
        events.push("release:deepseek-harness");
      },
    },
    "runner-v2": {
      launch: () => events.push("launch:runner-v2"),
      release: () => {
        events.push("release:runner-v2");
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  await assert.rejects(
    async () => executePreparedHarnessParityPair(pair),
    /deepseek launch failed/
  );
  assert.deepEqual(events, ["release:runner-v2", "release:deepseek-harness"]);
}

{
  const fixture = makeContract();
  const events: string[] = [];
  let runnerReleaseAttempts = 0;
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      release: () => {
        events.push("release:deepseek-harness");
      },
    },
    "runner-v2": {
      release: () => {
        events.push("release:runner-v2");
        if (runnerReleaseAttempts === 0) {
          runnerReleaseAttempts += 1;
          throw new Error("runner cleanup failed");
        }
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  await assert.rejects(
    async () => executePreparedHarnessParityPair(pair),
    (error) =>
      error instanceof HarnessParityCleanupError &&
      error.code === "cleanup_failed" &&
      error.cleanupErrors.length === 1
  );
  assert.deepEqual(events, ["release:runner-v2", "release:deepseek-harness"]);
  await releasePreparedHarnessParityPair(pair);
  assert.deepEqual(events, [
    "release:runner-v2",
    "release:deepseek-harness",
    "release:runner-v2",
  ]);
}

// The existing sequential behavior survives the trusted preparation boundary.
{
  const fixture = makeContract();
  const starts: HarnessId[] = [];
  const pendingDeepseek = deferred<string>();
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      launch: () => {
        starts.push("deepseek-harness");
        return pendingDeepseek.promise;
      },
    },
    "runner-v2": {
      launch: () => {
        starts.push("runner-v2");
        return "runner";
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  const execution = executePreparedHarnessParityPair(pair);
  assert.deepEqual(starts, []);
  await Promise.resolve();
  assert.deepEqual(starts, ["deepseek-harness"]);
  pendingDeepseek.resolve("deepseek");
  const result = await execution;
  assert.deepEqual(starts, ["deepseek-harness", "runner-v2"]);
  assert.deepEqual(
    result.map((entry) => entry.result),
    ["deepseek", "runner"]
  );
}

{
  const fixture = makeContract();
  const starts: HarnessId[] = [];
  const leases = leasesFor(fixture, {
    "deepseek-harness": {
      launch: () => {
        starts.push("deepseek-harness");
        return Promise.reject(new Error("deepseek failed"));
      },
    },
    "runner-v2": {
      launch: () => {
        starts.push("runner-v2");
        return "runner";
      },
    },
  });
  const pair = await preparePair(fixture, leases);
  await assert.rejects(async () => executePreparedHarnessParityPair(pair), /deepseek failed/);
  assert.deepEqual(starts, ["deepseek-harness"]);
}

console.log("robust-build trusted parity preparation tests passed");
