import {
  HARNESS_ARCHITECTURES,
  HARNESS_DEADLINE_POLICIES,
  HARNESS_DEPENDENCY_POLICIES,
  HARNESS_ISOLATION_POLICIES,
  HARNESS_MONOTONIC_CLOCK_SOURCES,
  HARNESS_NETWORK_POLICIES,
  HARNESS_PERMISSION_CAPABILITIES,
  HARNESS_PLATFORMS,
  HARNESS_PORT_POLICIES,
  HARNESS_PROCESS_TREE_POLICIES,
  ROBUST_BUILD_HARNESS_IDS,
  type HarnessParityArm,
  type HarnessParityContract,
  type HarnessParityEnvironment,
  type HarnessParityLaunchInput,
  type HarnessParityLimits,
  type HarnessParityMaybePromise,
  type HarnessParityObservedFacts,
  type HarnessParityPolicy,
  type HarnessParityPreparationAdapter,
  type HarnessParityRole,
  type HarnessParitySource,
  type PairedHarnessArmResult,
  type PreparedHarnessParityPair,
  type RobustBuildHarnessId,
  type TrustedHarnessParityAuthority,
  type TrustedHarnessParityLease,
} from "./types";

/**
 * Resolved full commit for the plan's documented `b150a55` DeepSeek Harness
 * label (`dsh-v0.1.1-rc.2`). Abbreviated revisions are deliberately rejected.
 */
export const DEEPSEEK_HARNESS_SOURCE_REVISION =
  "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";

export type HarnessParityErrorCode =
  | "invalid_contract"
  | "invalid_execution_order"
  | "invalid_source_revision"
  | "missing_value"
  | "parity_mismatch"
  | "invalid_authority"
  | "invalid_preparation"
  | "observed_fact_mismatch"
  | "invalid_prepared_pair"
  | "seal_validation_failed"
  | "cleanup_failed";

export class HarnessParityError extends Error {
  readonly code: HarnessParityErrorCode;

  constructor(code: HarnessParityErrorCode, message: string) {
    super(message);
    this.name = "HarnessParityError";
    this.code = code;
  }
}

export interface HarnessParityCleanupFailure {
  readonly harness: RobustBuildHarnessId;
  readonly error: unknown;
}

/**
 * Cleanup is never best-effort. If a primary failure and one or more releases
 * both fail, this typed error preserves all of that evidence and a
 * module-issued recovery capability instead of silently discarding either.
 */
export class HarnessParityCleanupError extends HarnessParityError {
  readonly primaryError: unknown | undefined;
  readonly cleanupErrors: readonly unknown[];
  readonly cleanupFailures: readonly HarnessParityCleanupFailure[];
  readonly recoveryPair: PreparedHarnessParityPair<unknown>;

  constructor(
    primaryError: unknown | undefined,
    cleanupFailures: readonly HarnessParityCleanupFailure[],
    recoveryPair: PreparedHarnessParityPair<unknown>
  ) {
    super(
      "cleanup_failed",
      `Harness parity cleanup recorded ${cleanupFailures.length} failed release attempt${
        cleanupFailures.length === 1 ? "" : "s"
      }.`
    );
    this.name = "HarnessParityCleanupError";
    this.primaryError = primaryError;
    this.cleanupFailures = Object.freeze(
      cleanupFailures.map((failure) =>
        Object.freeze({ harness: failure.harness, error: failure.error })
      )
    );
    this.cleanupErrors = Object.freeze(this.cleanupFailures.map((failure) => failure.error));
    this.recoveryPair = recoveryPair;
  }
}

type UnknownRecord = Record<string, unknown>;

type InternalReleaseOwner = Readonly<{
  harness: RobustBuildHarnessId;
  release: () => HarnessParityMaybePromise<void>;
}>;

type InternalLease<T> = Readonly<
  InternalReleaseOwner & {
  arm: HarnessParityArm;
  observedFacts: HarnessParityObservedFacts;
  revalidate: () => HarnessParityMaybePromise<HarnessParityObservedFacts>;
  launch: (input: HarnessParityLaunchInput) => HarnessParityMaybePromise<T>;
  }
>;

interface SharedPreparedPairState<T> {
  readonly capability: PreparedHarnessParityPair<T>;
  readonly unreleasedOwners: InternalReleaseOwner[];
  cleanupPrimaryError: unknown | undefined;
  cleanupFailureHistory: HarnessParityCleanupFailure[];
  status: "prepared" | "executing" | "releasing" | "cleanup-failed" | "released";
}

interface ExecutablePreparedPairState<T> extends SharedPreparedPairState<T> {
  readonly kind: "executable";
  readonly contract: HarnessParityContract;
  readonly leases: Readonly<Record<RobustBuildHarnessId, InternalLease<T>>>;
}

interface CleanupOnlyPreparedPairState extends SharedPreparedPairState<unknown> {
  readonly kind: "cleanup-only";
}

type PreparedPairState<T> =
  | ExecutablePreparedPairState<T>
  | CleanupOnlyPreparedPairState;

interface TrustedAuthorityState<T> {
  readonly prepare: HarnessParityPreparationAdapter<T>["prepare"];
}

const preparedPairStates = new WeakMap<object, PreparedPairState<unknown>>();
const trustedAuthorityStates = new WeakMap<object, TrustedAuthorityState<unknown>>();

const ARM_KEYS = ROBUST_BUILD_HARNESS_IDS;
const LIMIT_KEYS = [
  "maxInputTokens",
  "maxOutputTokens",
  "maxModelCalls",
  "maxToolCalls",
  "maxCostUsd",
  "maxWallClockMs",
] as const;
const INTEGER_LIMIT_KEYS = new Set<string>([
  "maxInputTokens",
  "maxOutputTokens",
  "maxModelCalls",
  "maxToolCalls",
  "maxWallClockMs",
]);
const CONTRACT_KEYS = ["schemaVersion", "requiredRoles", "executionOrder", "arms"] as const;
const ARM_FIELDS = [
  "harness",
  "source",
  "providerId",
  "modelId",
  "reasoningEffort",
  "roles",
  "limits",
  "policy",
  "environment",
  "baseRepositoryHash",
  "caseHash",
] as const;
const SOURCE_FIELDS = ["revision", "treeHash", "dependencyLockHash"] as const;
const ROLE_FIELDS = ["role", "available", "providerId", "modelId", "reasoningEffort"] as const;
const POLICY_FIELDS = ["version", "permissions", "network"] as const;
const ENVIRONMENT_FIELDS = [
  "version",
  "platform",
  "architecture",
  "clock",
  "dependencies",
  "workspace",
  "state",
  "processTree",
  "ports",
] as const;
const CLOCK_FIELDS = ["source", "deadlinePolicy"] as const;
const DEPENDENCY_FIELDS = ["policy", "prefetchManifestHash"] as const;
const PREPARATION_ADAPTER_FIELDS = ["prepare"] as const;
const LEASE_FIELDS = ["observedFacts", "revalidate", "launch", "release"] as const;

/**
 * Parses a contract into a fresh immutable value. Only harness identity and
 * sealed harness-source values may differ between the two arms. Everything
 * needed to compare a scored execution must be complete and equal.
 */
export function createHarnessParityContract(input: unknown): HarnessParityContract {
  const raw = readDataRecord(input, "contract", "invalid_contract");
  assertExactKeys(raw, CONTRACT_KEYS, "contract");
  if (raw.schemaVersion !== 1) {
    fail("invalid_contract", "Harness parity contract schemaVersion must be 1.");
  }

  const requiredRoles = parseRequiredRoles(raw.requiredRoles);
  const executionOrder = parseExecutionOrder(raw.executionOrder);
  const rawArms = readDataRecord(raw.arms, "contract.arms", "invalid_contract");
  assertExactKeys(rawArms, ARM_KEYS, "contract.arms");

  const deepseek = parseArm(
    rawArms["deepseek-harness"],
    "deepseek-harness",
    requiredRoles,
    "contract.arms.deepseek-harness"
  );
  const runner = parseArm(
    rawArms["runner-v2"],
    "runner-v2",
    requiredRoles,
    "contract.arms.runner-v2"
  );

  assertArmsHaveParity(deepseek, runner);

  return freezeContract({
    schemaVersion: 1,
    requiredRoles,
    executionOrder,
    arms: {
      "deepseek-harness": deepseek,
      "runner-v2": runner,
    },
  });
}

/** Returns the frozen, canonicalized form used for identities and execution. */
export function canonicalHarnessParityContract(input: unknown): HarnessParityContract {
  return createHarnessParityContract(input);
}

/**
 * A deterministic, collision-free identity for the complete sealed contract.
 * A verified later Runner revision intentionally produces a different identity
 * when it is supplied by a new contract; Runner itself is not permanently
 * pinned to this source file's revision.
 */
export function canonicalHarnessParityIdentity(input: unknown): string {
  return `robust-build-parity-v1:${stableStringify(createHarnessParityContract(input))}`;
}

/**
 * Admits a P6.2 preparation adapter at the explicit trust boundary and
 * returns a module-issued opaque authority. The adapter is responsible for
 * independently probing effective facts and for owning model-free leases; a
 * raw { prepare } object is deliberately not usable by pair preparation.
 */
export function createTrustedHarnessParityAuthority<T>(
  adapter: unknown
): TrustedHarnessParityAuthority<T> {
  const prepare = parsePreparationAdapter<T>(adapter);
  const authority = Object.freeze({}) as unknown as TrustedHarnessParityAuthority<T>;
  trustedAuthorityStates.set(
    authority as unknown as object,
    Object.freeze({ prepare }) as unknown as TrustedAuthorityState<unknown>
  );
  return authority;
}

/**
 * Validates the sealed contract before model work and asks the trusted,
 * model-free authority to acquire both owned leases. Each lease returns facts
 * independently observed by its adapter; copied contract claims are not an
 * execution input. Every acquired lease remains owned until pair execution
 * finishes or preparation rolls back.
 */
export function prepareHarnessParityPair<T>(
  input: unknown,
  authority: unknown
): Promise<PreparedHarnessParityPair<T>> {
  const contract = createHarnessParityContract(input);
  const prepare = requireTrustedAuthority<T>(authority);
  return prepareBothHarnessArms(contract, prepare);
}

/**
 * Executes only a module-issued opaque pair. Launchers originate from the
 * retained trusted leases, never from a caller-provided callback. Every arm is
 * revalidated immediately before launch; a first-arm side effect that changes
 * the second lease therefore rejects the pair before the second launcher runs.
 */
export function executePreparedHarnessParityPair<T>(
  preparedPair: unknown
): Promise<readonly PairedHarnessArmResult<T>[]> {
  const state = requirePreparedPairState<T>(preparedPair);
  if (state.kind !== "executable" || state.status !== "prepared") {
    fail("invalid_prepared_pair", "Harness parity prepared pair is no longer executable.");
  }
  state.status = "executing";
  return executeAndReleasePreparedPair(state);
}

/**
 * Releases an unused, module-issued pair. Callers that prepare a pair but do
 * not execute it must cancel it through this API so retained
 * workspace/state/process/port leases cannot be abandoned. This is also the
 * recovery path after an execution cleanup failure. Releases happen in reverse
 * preparation order; a failed release stays retained and may be retried through
 * this same opaque pair without repeating successful releases.
 */
export function releasePreparedHarnessParityPair(preparedPair: unknown): Promise<void> {
  const state = requirePreparedPairState<unknown>(preparedPair);
  if (state.status !== "prepared" && state.status !== "cleanup-failed") {
    fail("invalid_prepared_pair", "Harness parity prepared pair is no longer releasable.");
  }
  state.status = "releasing";
  return releasePreparedPair(state);
}

function parseArm(
  input: unknown,
  expectedHarness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string,
  environmentMode: "sealed-contract" | "observed" = "sealed-contract"
): HarnessParityArm {
  const raw = readDataRecord(input, path, "invalid_contract");
  assertExactKeys(raw, ARM_FIELDS, path);
  return parseArmFields(raw, expectedHarness, requiredRoles, path, environmentMode);
}

function parseArmFields(
  raw: UnknownRecord,
  expectedHarness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string,
  environmentMode: "sealed-contract" | "observed"
): HarnessParityArm {
  const harness = parseHarnessId(raw.harness, `${path}.harness`);
  if (harness !== expectedHarness) {
    fail(
      "invalid_contract",
      `Harness parity arm ${expectedHarness} reported harness identity ${harness}.`
    );
  }

  return {
    harness,
    source: parseSource(raw.source, expectedHarness, `${path}.source`),
    providerId: requireText(raw.providerId, `${path}.providerId`),
    modelId: requireText(raw.modelId, `${path}.modelId`),
    reasoningEffort: requireText(raw.reasoningEffort, `${path}.reasoningEffort`),
    roles: parseRoles(raw.roles, expectedHarness, requiredRoles, `${path}.roles`),
    limits: parseLimits(raw.limits, `${path}.limits`),
    policy: parsePolicy(raw.policy, `${path}.policy`),
    environment: parseEnvironment(raw.environment, `${path}.environment`, environmentMode),
    baseRepositoryHash: requireHash(raw.baseRepositoryHash, `${path}.baseRepositoryHash`),
    caseHash: requireHash(raw.caseHash, `${path}.caseHash`),
  };
}

function parseSource(
  input: unknown,
  harness: RobustBuildHarnessId,
  path: string
): HarnessParitySource {
  const raw = readDataRecord(input, path, "invalid_contract");
  assertExactKeys(raw, SOURCE_FIELDS, path);
  const revision = requireRevision(raw.revision, `${path}.revision`);
  if (harness === "deepseek-harness" && revision !== DEEPSEEK_HARNESS_SOURCE_REVISION) {
    fail(
      "invalid_source_revision",
      `DeepSeek Harness source revision must equal ${DEEPSEEK_HARNESS_SOURCE_REVISION}.`
    );
  }
  return {
    revision,
    treeHash: requireHash(raw.treeHash, `${path}.treeHash`),
    dependencyLockHash: requireHash(raw.dependencyLockHash, `${path}.dependencyLockHash`),
  };
}

function parseRequiredRoles(input: unknown): readonly string[] {
  const roles = readDataArray(input, "contract.requiredRoles", "invalid_contract");
  if (roles.length === 0) {
    fail("missing_value", "Harness parity contract requires at least one required role.");
  }
  return normalizeUniqueTexts(roles, "contract.requiredRoles");
}

function parseExecutionOrder(
  input: unknown
): readonly [RobustBuildHarnessId, RobustBuildHarnessId] {
  const order = readDataArray(input, "contract.executionOrder", "invalid_execution_order");
  if (order.length !== ARM_KEYS.length) {
    fail("invalid_execution_order", "Harness parity execution order must contain exactly two arms.");
  }
  const first = parseHarnessId(order[0], "contract.executionOrder[0]");
  const second = parseHarnessId(order[1], "contract.executionOrder[1]");
  if (first === second) {
    fail(
      "invalid_execution_order",
      "Harness parity execution order must contain each harness exactly once."
    );
  }
  return [first, second];
}

function parseRoles(
  input: unknown,
  harness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string
): readonly HarnessParityRole[] {
  const values = readDataArray(input, path, "invalid_contract");
  if (values.length !== requiredRoles.length) {
    fail(
      "missing_value",
      `Harness parity arm ${harness} must report every required role exactly once.`
    );
  }

  const roles: HarnessParityRole[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const rolePath = `${path}[${index}]`;
    const raw = readDataRecord(values[index], rolePath, "invalid_contract");
    assertExactKeys(raw, ROLE_FIELDS, rolePath);
    if (raw.available !== true) {
      fail(
        "missing_value",
        `${rolePath}.available must be explicitly reported as true for every required role.`
      );
    }
    roles.push({
      role: requireText(raw.role, `${rolePath}.role`),
      available: true,
      providerId: requireText(raw.providerId, `${rolePath}.providerId`),
      modelId: requireText(raw.modelId, `${rolePath}.modelId`),
      reasoningEffort: requireText(raw.reasoningEffort, `${rolePath}.reasoningEffort`),
    });
  }

  const names = roles.map((role) => role.role);
  if (new Set(names).size !== names.length) {
    fail("invalid_contract", `Harness parity arm ${harness} reported a duplicate role mapping.`);
  }
  const sortedNames = [...names].sort(compareText);
  if (!sameStringArray(sortedNames, requiredRoles)) {
    fail(
      "missing_value",
      `Harness parity arm ${harness} is missing a required role or reported an undeclared role.`
    );
  }
  return roles.sort((left, right) => compareText(left.role, right.role));
}

function parseLimits(input: unknown, path: string): HarnessParityLimits {
  const raw = readDataRecord(input, path, "invalid_contract");
  assertExactKeys(raw, LIMIT_KEYS, path);
  const values = {} as Record<(typeof LIMIT_KEYS)[number], number>;
  for (const key of LIMIT_KEYS) {
    values[key] = requireNonNegativeNumber(
      raw[key],
      `${path}.${key}`,
      INTEGER_LIMIT_KEYS.has(key)
    );
  }
  return values as HarnessParityLimits;
}

function parsePolicy(input: unknown, path: string): HarnessParityPolicy {
  const raw = readDataRecord(input, path, "invalid_contract");
  assertExactKeys(raw, POLICY_FIELDS, path);
  if (raw.version !== 1) {
    fail("invalid_contract", `${path}.version must be 1.`);
  }
  return {
    version: 1,
    permissions: normalizeUniqueEnums(
      readDataArray(raw.permissions, `${path}.permissions`, "invalid_contract"),
      HARNESS_PERMISSION_CAPABILITIES,
      `${path}.permissions`
    ),
    network: requireEnum(raw.network, HARNESS_NETWORK_POLICIES, `${path}.network`),
  };
}

function parseEnvironment(
  input: unknown,
  path: string,
  mode: "sealed-contract" | "observed"
): HarnessParityEnvironment {
  const raw = readDataRecord(input, path, "invalid_contract");
  assertExactKeys(raw, ENVIRONMENT_FIELDS, path);
  if (raw.version !== 1) {
    fail("invalid_contract", `${path}.version must be 1.`);
  }

  const clockPath = `${path}.clock`;
  const clock = readDataRecord(raw.clock, clockPath, "invalid_contract");
  assertExactKeys(clock, CLOCK_FIELDS, clockPath);

  const dependenciesPath = `${path}.dependencies`;
  const dependencies = readDataRecord(raw.dependencies, dependenciesPath, "invalid_contract");
  assertExactKeys(dependencies, DEPENDENCY_FIELDS, dependenciesPath);

  const environment: HarnessParityEnvironment = {
    version: 1,
    platform: requireEnum(raw.platform, HARNESS_PLATFORMS, `${path}.platform`),
    architecture: requireEnum(raw.architecture, HARNESS_ARCHITECTURES, `${path}.architecture`),
    clock: {
      source: requireEnum(clock.source, HARNESS_MONOTONIC_CLOCK_SOURCES, `${clockPath}.source`),
      deadlinePolicy: requireEnum(
        clock.deadlinePolicy,
        HARNESS_DEADLINE_POLICIES,
        `${clockPath}.deadlinePolicy`
      ),
    },
    dependencies: {
      policy: requireEnum(
        dependencies.policy,
        HARNESS_DEPENDENCY_POLICIES,
        `${dependenciesPath}.policy`
      ),
      prefetchManifestHash: requireHash(
        dependencies.prefetchManifestHash,
        `${dependenciesPath}.prefetchManifestHash`
      ),
    },
    workspace: requireEnum(raw.workspace, HARNESS_ISOLATION_POLICIES, `${path}.workspace`),
    state: requireEnum(raw.state, HARNESS_ISOLATION_POLICIES, `${path}.state`),
    processTree: requireEnum(
      raw.processTree,
      HARNESS_PROCESS_TREE_POLICIES,
      `${path}.processTree`
    ),
    ports: requireEnum(raw.ports, HARNESS_PORT_POLICIES, `${path}.ports`),
  };
  if (mode === "sealed-contract") {
    assertSafeSealedEnvironment(environment, path);
  }
  return environment;
}

function assertSafeSealedEnvironment(environment: HarnessParityEnvironment, path: string): void {
  if (environment.dependencies.policy !== "locked-prefetched") {
    fail("invalid_contract", `${path}.dependencies.policy must be locked-prefetched.`);
  }
  if (environment.workspace !== "fresh-isolated") {
    fail("invalid_contract", `${path}.workspace must be fresh-isolated.`);
  }
  if (environment.state !== "fresh-isolated") {
    fail("invalid_contract", `${path}.state must be fresh-isolated.`);
  }
  if (environment.processTree !== "owned-process-tree") {
    fail("invalid_contract", `${path}.processTree must be owned-process-tree.`);
  }
  if (environment.ports !== "exclusive-reserved") {
    fail("invalid_contract", `${path}.ports must be exclusive-reserved.`);
  }
}

function assertArmsHaveParity(deepseek: HarnessParityArm, runner: HarnessParityArm): void {
  assertSame(deepseek.providerId, runner.providerId, "providerId");
  assertSame(deepseek.modelId, runner.modelId, "modelId");
  assertSame(deepseek.reasoningEffort, runner.reasoningEffort, "reasoningEffort");
  assertSameStable(deepseek.roles, runner.roles, "role mapping");
  assertSameStable(deepseek.limits, runner.limits, "limits");
  assertSameStable(deepseek.policy, runner.policy, "policy");
  assertSameStable(deepseek.environment, runner.environment, "environment");
  assertSame(deepseek.baseRepositoryHash, runner.baseRepositoryHash, "baseRepositoryHash");
  assertSame(deepseek.caseHash, runner.caseHash, "caseHash");
}

function parsePreparationAdapter<T>(
  input: unknown
): HarnessParityPreparationAdapter<T>["prepare"] {
  const raw = readDataRecord(input, "preparationAdapter", "invalid_authority");
  assertExactKeys(
    raw,
    PREPARATION_ADAPTER_FIELDS,
    "preparationAdapter",
    "invalid_authority",
    "invalid_authority"
  );
  if (typeof raw.prepare !== "function") {
    fail("invalid_authority", "preparationAdapter.prepare must be a preparation function.");
  }
  return raw.prepare as HarnessParityPreparationAdapter<T>["prepare"];
}

function requireTrustedAuthority<T>(
  authority: unknown
): HarnessParityPreparationAdapter<T>["prepare"] {
  if (typeof authority !== "object" || authority === null) {
    fail("invalid_authority", "Harness parity preparation requires a module-issued authority.");
  }
  const state = trustedAuthorityStates.get(authority);
  if (!state) {
    fail("invalid_authority", "Harness parity preparation requires a module-issued authority.");
  }
  return state.prepare as HarnessParityPreparationAdapter<T>["prepare"];
}

async function prepareBothHarnessArms<T>(
  contract: HarnessParityContract,
  prepare: HarnessParityPreparationAdapter<T>["prepare"]
): Promise<PreparedHarnessParityPair<T>> {
  const acquired: InternalLease<T>[] = [];
  const rollbackOwners: InternalReleaseOwner[] = [];
  try {
    for (const harness of ARM_KEYS) {
      const arm = contract.arms[harness];
      const rawLease = await prepare(
        Object.freeze({
          harness,
          arm,
          contract,
        })
      );
      const provisionalOwner = extractProvisionalReleaseOwner(
        rawLease,
        harness
      );
      if (provisionalOwner) rollbackOwners.push(provisionalOwner);
      const lease = parseTrustedLease<T>(rawLease, harness, contract, `authority.${harness}`);
      acquired.push(lease);
      assertObservedFactsMatchArm(
        lease.observedFacts,
        arm,
        harness,
        "observed_fact_mismatch",
        "preparation"
      );
    }
  } catch (error) {
    const cleanupFailures = await releaseOwnersInReverse(rollbackOwners);
    if (cleanupFailures.length > 0) {
      const recoveryPair = issueCleanupOnlyPreparedPair(
        rollbackOwners,
        error,
        cleanupFailures
      );
      throw new HarnessParityCleanupError(error, cleanupFailures, recoveryPair);
    }
    throw error;
  }

  const leases = {} as Record<RobustBuildHarnessId, InternalLease<T>>;
  for (const lease of acquired) leases[lease.harness] = lease;
  return issueExecutablePreparedPair(
    contract,
    Object.freeze({
      "deepseek-harness": leases["deepseek-harness"],
      "runner-v2": leases["runner-v2"],
    })
  );
}

function parseTrustedLease<T>(
  input: unknown,
  expectedHarness: RobustBuildHarnessId,
  contract: HarnessParityContract,
  path: string
): InternalLease<T> {
  const raw = readDataRecord(input, path, "invalid_preparation");
  assertExactKeys(raw, LEASE_FIELDS, path, "invalid_preparation", "invalid_preparation");
  if (
    typeof raw.revalidate !== "function" ||
    typeof raw.launch !== "function" ||
    typeof raw.release !== "function"
  ) {
    fail("invalid_preparation", `${path} must provide trusted revalidate, launch, and release functions.`);
  }
  const observedFacts = parseObservedFacts(
    raw.observedFacts,
    expectedHarness,
    contract.requiredRoles,
    `${path}.observedFacts`
  );
  return Object.freeze({
    harness: expectedHarness,
    arm: contract.arms[expectedHarness],
    observedFacts,
    revalidate: raw.revalidate as TrustedHarnessParityLease<T>["revalidate"],
    launch: raw.launch as TrustedHarnessParityLease<T>["launch"],
    release: raw.release as TrustedHarnessParityLease<T>["release"],
  });
}

/**
 * Reads only the own release descriptor before full lease validation. This
 * deliberately keeps a callable data-property release handle for rollback
 * when another lease field is malformed; accessors are never invoked.
 */
function extractProvisionalReleaseOwner(
  input: unknown,
  harness: RobustBuildHarnessId
): InternalReleaseOwner | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, "release");
  if (
    !descriptor ||
    !descriptor.enumerable ||
    !isDataDescriptor(descriptor) ||
    typeof descriptor.value !== "function"
  ) {
    return undefined;
  }
  return Object.freeze({
    harness,
    release: descriptor.value as () => HarnessParityMaybePromise<void>,
  });
}

function parseObservedFacts(
  input: unknown,
  expectedHarness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string
): HarnessParityObservedFacts {
  return freezeObservedFacts(
    parseArm(input, expectedHarness, requiredRoles, path, "observed")
  );
}

function assertObservedFactsMatchArm(
  observedFacts: HarnessParityObservedFacts,
  arm: HarnessParityArm,
  harness: RobustBuildHarnessId,
  code: "observed_fact_mismatch" | "seal_validation_failed",
  phase: "preparation" | "revalidation"
): void {
  if (stableStringify(observedFacts) !== stableStringify(arm)) {
    fail(
      code,
      `Trusted ${phase} facts for ${harness} do not match the sealed parity contract.`
    );
  }
}

function issueExecutablePreparedPair<T>(
  contract: HarnessParityContract,
  leases: Readonly<Record<RobustBuildHarnessId, InternalLease<T>>>
): PreparedHarnessParityPair<T> {
  const capability = Object.freeze({}) as unknown as PreparedHarnessParityPair<T>;
  const state: ExecutablePreparedPairState<T> = {
    capability,
    kind: "executable",
    contract,
    leases,
    unreleasedOwners: ARM_KEYS.map((harness) =>
      Object.freeze({
        harness,
        release: leases[harness].release,
      })
    ),
    cleanupPrimaryError: undefined,
    cleanupFailureHistory: [],
    status: "prepared",
  };
  preparedPairStates.set(
    capability as unknown as object,
    state as unknown as PreparedPairState<unknown>
  );
  return capability;
}

function issueCleanupOnlyPreparedPair(
  unreleasedOwners: readonly InternalReleaseOwner[],
  primaryError: unknown,
  cleanupFailures: readonly HarnessParityCleanupFailure[]
): PreparedHarnessParityPair<unknown> {
  const capability = Object.freeze({}) as unknown as PreparedHarnessParityPair<unknown>;
  const state: CleanupOnlyPreparedPairState = {
    capability,
    kind: "cleanup-only",
    unreleasedOwners: [...unreleasedOwners],
    cleanupPrimaryError: primaryError,
    cleanupFailureHistory: [...cleanupFailures],
    status: "cleanup-failed",
  };
  preparedPairStates.set(capability as unknown as object, state);
  return capability;
}

function requirePreparedPairState<T>(preparedPair: unknown): PreparedPairState<T> {
  if (typeof preparedPair !== "object" || preparedPair === null) {
    fail("invalid_prepared_pair", "Harness parity execution requires a module-issued prepared pair.");
  }
  const state = preparedPairStates.get(preparedPair);
  if (!state) {
    fail("invalid_prepared_pair", "Harness parity execution requires a module-issued prepared pair.");
  }
  return state as unknown as PreparedPairState<T>;
}

async function executeAndReleasePreparedPair<T>(
  state: ExecutablePreparedPairState<T>
): Promise<readonly PairedHarnessArmResult<T>[]> {
  let hasPrimaryError = false;
  let primaryError: unknown;
  let results: readonly PairedHarnessArmResult<T>[] = Object.freeze([]);

  try {
    const completed: PairedHarnessArmResult<T>[] = [];
    for (const harness of state.contract.executionOrder) {
      const lease = state.leases[harness];
      const observedFacts = parseObservedFacts(
        await lease.revalidate(),
        harness,
        state.contract.requiredRoles,
        `preparedPair.${harness}.revalidate`
      );
      assertObservedFactsMatchArm(
        observedFacts,
        lease.arm,
        harness,
        "seal_validation_failed",
        "revalidation"
      );
      const result = await lease.launch(
        Object.freeze({
          harness,
          arm: lease.arm,
          observedFacts,
          contract: state.contract,
        })
      );
      completed.push(
        Object.freeze({
          harness,
          observedFacts,
          result,
        })
      );
    }
    results = Object.freeze(completed);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupFailures = await releaseOwnersInReverse(state.unreleasedOwners);
  if (cleanupFailures.length > 0) {
    recordCleanupFailures(state, hasPrimaryError ? primaryError : undefined, cleanupFailures);
    throw createCleanupError(state);
  }
  state.status = "released";
  if (hasPrimaryError) throw primaryError;
  return results;
}

async function releasePreparedPair<T>(state: PreparedPairState<T>): Promise<void> {
  const cleanupFailures = await releaseOwnersInReverse(state.unreleasedOwners);
  if (cleanupFailures.length > 0) {
    recordCleanupFailures(state, undefined, cleanupFailures);
    throw createCleanupError(state);
  }
  state.status = "released";
}

function recordCleanupFailures<T>(
  state: PreparedPairState<T>,
  primaryError: unknown | undefined,
  cleanupFailures: readonly HarnessParityCleanupFailure[]
): void {
  if (state.cleanupFailureHistory.length === 0) {
    state.cleanupPrimaryError = primaryError;
  }
  state.cleanupFailureHistory.push(...cleanupFailures);
  state.status = "cleanup-failed";
}

function createCleanupError<T>(state: PreparedPairState<T>): HarnessParityCleanupError {
  return new HarnessParityCleanupError(
    state.cleanupPrimaryError,
    state.cleanupFailureHistory,
    state.capability as unknown as PreparedHarnessParityPair<unknown>
  );
}

async function releaseOwnersInReverse(
  owners: InternalReleaseOwner[]
): Promise<readonly HarnessParityCleanupFailure[]> {
  const cleanupFailures: HarnessParityCleanupFailure[] = [];
  for (let index = owners.length - 1; index >= 0; index -= 1) {
    const owner = owners[index];
    try {
      await owner.release();
      owners.splice(index, 1);
    } catch (error) {
      cleanupFailures.push(Object.freeze({ harness: owner.harness, error }));
    }
  }
  return Object.freeze(cleanupFailures);
}

function assertSame(left: unknown, right: unknown, field: string): void {
  if (left !== right) {
    fail("parity_mismatch", `Harness parity mismatch: ${field} differs between arms.`);
  }
}

function assertSameStable(left: unknown, right: unknown, field: string): void {
  if (stableStringify(left) !== stableStringify(right)) {
    fail("parity_mismatch", `Harness parity mismatch: ${field} differs between arms.`);
  }
}

function parseHarnessId(value: unknown, path: string): RobustBuildHarnessId {
  if (value === "deepseek-harness" || value === "runner-v2") return value;
  fail("invalid_contract", `${path} must be a known robust-build harness identity.`);
}

function requireRevision(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    fail("invalid_source_revision", `${path} must be a full lowercase 40-character Git revision.`);
  }
  return value;
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) {
    fail("missing_value", `${path} must be a full lowercase SHA-1 or SHA-256 hash.`);
  }
  return value;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail("missing_value", `${path} must be a non-empty trimmed string.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string, integer: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isInteger(value))
  ) {
    fail(
      "missing_value",
      `${path} must be a finite non-negative${integer ? " integer" : " number"}.`
    );
  }
  return Object.is(value, -0) ? 0 : value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail("invalid_contract", `${path} must be a supported sealed parity value.`);
  }
  return value as T;
}

/**
 * Copies only own enumerable data properties. This intentionally never reads a
 * property from the supplied object: accessors, symbols, and hidden properties
 * are rejected before their values can be observed.
 */
function readDataRecord(
  value: unknown,
  path: string,
  invalidCode: HarnessParityErrorCode
): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(invalidCode, `${path} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(invalidCode, `${path} must be a plain object.`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(invalidCode, `${path} must not contain symbol properties.`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copied = Object.create(null) as UnknownRecord;
  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptorEntry = Object.getOwnPropertyDescriptor(descriptors, key);
    const descriptor = descriptorEntry?.value as PropertyDescriptor | undefined;
    if (!descriptor || !descriptor.enumerable) {
      fail(invalidCode, `${path}.${key} must be an enumerable data property.`);
    }
    if (!isDataDescriptor(descriptor)) {
      fail(invalidCode, `${path}.${key} must not be an accessor property.`);
    }
    Object.defineProperty(copied, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    });
  }
  return copied;
}

/**
 * Copies only dense arrays of own enumerable data properties. The unavoidable
 * built-in `length` slot is validated separately; all other hidden, accessor,
 * symbol, sparse, or custom properties fail closed.
 */
function readDataArray(
  value: unknown,
  path: string,
  invalidCode: HarnessParityErrorCode
): unknown[] {
  if (!Array.isArray(value)) {
    fail(invalidCode, `${path} must be reported as an array.`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(invalidCode, `${path} must not contain symbol properties.`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const propertyNames = Object.getOwnPropertyNames(descriptors);
  const lengthEntry = Object.getOwnPropertyDescriptor(descriptors, "length");
  const lengthDescriptor = lengthEntry?.value as PropertyDescriptor | undefined;
  if (!lengthDescriptor || !isDataDescriptor(lengthDescriptor) || lengthDescriptor.enumerable) {
    fail(invalidCode, `${path}.length must be the standard non-enumerable data property.`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    fail(invalidCode, `${path}.length must be a safe non-negative integer.`);
  }

  const elements: Array<{ index: number; value: unknown }> = [];
  for (const key of propertyNames) {
    if (key === "length") continue;
    const index = parseArrayIndex(key);
    if (index === undefined || index >= length) {
      fail(invalidCode, `${path}.${key} is not a permitted array element.`);
    }
    const descriptorEntry = Object.getOwnPropertyDescriptor(descriptors, key);
    const descriptor = descriptorEntry?.value as PropertyDescriptor | undefined;
    if (!descriptor || !descriptor.enumerable) {
      fail(invalidCode, `${path}[${index}] must be an enumerable data property.`);
    }
    if (!isDataDescriptor(descriptor)) {
      fail(invalidCode, `${path}[${index}] must not be an accessor property.`);
    }
    elements.push({ index, value: descriptor.value });
  }
  if (elements.length !== length) {
    fail(invalidCode, `${path} must be a dense array without omitted values.`);
  }

  const copied = new Array<unknown>(length);
  for (const element of elements) {
    copied[element.index] = element.value;
  }
  return copied;
}

function isDataDescriptor(descriptor: PropertyDescriptor): descriptor is PropertyDescriptor & {
  value: unknown;
} {
  return Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function parseArrayIndex(key: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < 4_294_967_295 ? index : undefined;
}

function assertExactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
  invalidCode: HarnessParityErrorCode = "invalid_contract",
  missingCode: HarnessParityErrorCode = "missing_value"
): void {
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(missingCode, `${path}.${key} must be reported.`);
    }
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!expected.includes(key)) {
      fail(invalidCode, `${path}.${key} is not part of the parity contract schema.`);
    }
  }
}

function normalizeUniqueTexts(values: unknown[], path: string): readonly string[] {
  const normalized: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    normalized.push(requireText(values[index], `${path}[${index}]`));
  }
  const sorted = normalized.sort(compareText);
  if (new Set(sorted).size !== sorted.length) {
    fail("invalid_contract", `${path} must not contain duplicate values.`);
  }
  return sorted;
}

function normalizeUniqueEnums<T extends string>(
  values: unknown[],
  allowed: readonly T[],
  path: string
): readonly T[] {
  const normalized: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    normalized.push(requireEnum(values[index], allowed, `${path}[${index}]`));
  }
  const sorted = normalized.sort(compareText);
  if (new Set(sorted).size !== sorted.length) {
    fail("invalid_contract", `${path} must not contain duplicate values.`);
  }
  return sorted;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function freezeContract(input: {
  schemaVersion: 1;
  requiredRoles: readonly string[];
  executionOrder: readonly [RobustBuildHarnessId, RobustBuildHarnessId];
  arms: Record<RobustBuildHarnessId, HarnessParityArm>;
}): HarnessParityContract {
  return Object.freeze({
    schemaVersion: 1 as const,
    requiredRoles: Object.freeze([...input.requiredRoles]),
    executionOrder: Object.freeze([
      input.executionOrder[0],
      input.executionOrder[1],
    ]) as unknown as readonly [RobustBuildHarnessId, RobustBuildHarnessId],
    arms: Object.freeze({
      "deepseek-harness": freezeArm(input.arms["deepseek-harness"]),
      "runner-v2": freezeArm(input.arms["runner-v2"]),
    }),
  });
}

function freezeArm(arm: HarnessParityArm): HarnessParityArm {
  return Object.freeze({
    harness: arm.harness,
    source: freezeSource(arm.source),
    providerId: arm.providerId,
    modelId: arm.modelId,
    reasoningEffort: arm.reasoningEffort,
    roles: Object.freeze(
      arm.roles.map((role) =>
        Object.freeze({
          role: role.role,
          available: true as const,
          providerId: role.providerId,
          modelId: role.modelId,
          reasoningEffort: role.reasoningEffort,
        })
      )
    ),
    limits: Object.freeze({ ...arm.limits }),
    policy: Object.freeze({
      version: 1 as const,
      permissions: Object.freeze([...arm.policy.permissions]),
      network: arm.policy.network,
    }),
    environment: freezeEnvironment(arm.environment),
    baseRepositoryHash: arm.baseRepositoryHash,
    caseHash: arm.caseHash,
  });
}

function freezeObservedFacts(arm: HarnessParityArm): HarnessParityObservedFacts {
  return freezeArm(arm) as HarnessParityObservedFacts;
}

function freezeSource(source: HarnessParitySource): HarnessParitySource {
  return Object.freeze({
    revision: source.revision,
    treeHash: source.treeHash,
    dependencyLockHash: source.dependencyLockHash,
  });
}

function freezeEnvironment(environment: HarnessParityEnvironment): HarnessParityEnvironment {
  return Object.freeze({
    version: 1 as const,
    platform: environment.platform,
    architecture: environment.architecture,
    clock: Object.freeze({
      source: environment.clock.source,
      deadlinePolicy: environment.clock.deadlinePolicy,
    }),
    dependencies: Object.freeze({
      policy: environment.dependencies.policy,
      prefetchManifestHash: environment.dependencies.prefetchManifestHash,
    }),
    workspace: environment.workspace,
    state: environment.state,
    processTree: environment.processTree,
    ports: environment.ports,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as UnknownRecord;
  return `{${Object.getOwnPropertyNames(record)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function fail(code: HarnessParityErrorCode, message: string): never {
  throw new HarnessParityError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
