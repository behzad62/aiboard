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
  type HarnessParityArmCallback,
  type HarnessParityContract,
  type HarnessParityEnvironment,
  type HarnessParityLaunchAttestation,
  type HarnessParityLaunchRecord,
  type HarnessParityLimits,
  type HarnessParityPolicy,
  type HarnessParityRole,
  type HarnessParitySource,
  type PairedHarnessArmResult,
  type RobustBuildHarnessId,
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
  | "invalid_callbacks"
  | "missing_value"
  | "parity_mismatch"
  | "attestation_mismatch";

export class HarnessParityError extends Error {
  readonly code: HarnessParityErrorCode;

  constructor(code: HarnessParityErrorCode, message: string) {
    super(message);
    this.name = "HarnessParityError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

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
const ATTESTATION_FIELDS = ["schemaVersion", ...ARM_FIELDS] as const;
const LAUNCH_RECORD_FIELDS = ["attestation", "callback"] as const;

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
 * Validates the full contract, both launch records, both attestations, and
 * both callbacks before invoking either callback. Once preflight succeeds,
 * callbacks execute strictly in the declared order: arm B is not started
 * until arm A has settled successfully. If arm A rejects, the pair rejects
 * and arm B never starts.
 *
 * This wrapper is intentionally not `async`: malformed input throws
 * synchronously, before it can create a model-call promise or invoke a model
 * callback. Valid executions return a promise for the ordered pair.
 */
export function executeParityValidatedHarnessArms<T>(
  input: unknown,
  launchRecords: unknown
): Promise<readonly PairedHarnessArmResult<T>[]> {
  const contract = createHarnessParityContract(input);
  const records = parseLaunchRecords<T>(launchRecords, contract);
  return executeArmsInOrder(contract, records);
}

function parseArm(
  input: unknown,
  expectedHarness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string
): HarnessParityArm {
  const raw = readDataRecord(input, path, "invalid_contract");
  assertExactKeys(raw, ARM_FIELDS, path);
  return parseArmFields(raw, expectedHarness, requiredRoles, path);
}

function parseArmFields(
  raw: UnknownRecord,
  expectedHarness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string
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
    environment: parseEnvironment(raw.environment, `${path}.environment`),
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

function parseEnvironment(input: unknown, path: string): HarnessParityEnvironment {
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

  return {
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

function parseLaunchRecords<T>(
  input: unknown,
  contract: HarnessParityContract
): Readonly<Record<RobustBuildHarnessId, HarnessParityLaunchRecord<T>>> {
  const raw = readDataRecord(input, "launchRecords", "invalid_callbacks");
  assertExactKeys(raw, ARM_KEYS, "launchRecords", "invalid_callbacks", "invalid_callbacks");

  const records = {} as Record<RobustBuildHarnessId, HarnessParityLaunchRecord<T>>;
  for (const harness of ARM_KEYS) {
    const record = parseLaunchRecord<T>(raw[harness], harness, contract);
    assertAttestationMatchesArm(record.attestation, contract.arms[harness], harness);
    records[harness] = record;
  }
  return Object.freeze({
    "deepseek-harness": records["deepseek-harness"],
    "runner-v2": records["runner-v2"],
  });
}

function parseLaunchRecord<T>(
  input: unknown,
  harness: RobustBuildHarnessId,
  contract: HarnessParityContract
): HarnessParityLaunchRecord<T> {
  const path = `launchRecords.${harness}`;
  const raw = readDataRecord(input, path, "invalid_callbacks");
  assertExactKeys(raw, LAUNCH_RECORD_FIELDS, path, "invalid_callbacks", "invalid_callbacks");
  const callback = raw.callback;
  if (typeof callback !== "function") {
    fail("invalid_callbacks", `${path}.callback must be a function.`);
  }
  const attestation = parseLaunchAttestation(
    raw.attestation,
    harness,
    contract.requiredRoles,
    `${path}.attestation`
  );
  return Object.freeze({
    attestation,
    callback: callback as HarnessParityArmCallback<T>,
  });
}

function parseLaunchAttestation(
  input: unknown,
  expectedHarness: RobustBuildHarnessId,
  requiredRoles: readonly string[],
  path: string
): HarnessParityLaunchAttestation {
  const raw = readDataRecord(input, path, "invalid_callbacks");
  assertExactKeys(raw, ATTESTATION_FIELDS, path, "invalid_callbacks", "missing_value");
  if (raw.schemaVersion !== 1) {
    fail("invalid_callbacks", `${path}.schemaVersion must be 1.`);
  }
  return freezeAttestation({
    schemaVersion: 1,
    ...parseArmFields(raw, expectedHarness, requiredRoles, path),
  });
}

function assertAttestationMatchesArm(
  attestation: HarnessParityLaunchAttestation,
  arm: HarnessParityArm,
  harness: RobustBuildHarnessId
): void {
  const attestedArm: HarnessParityArm = {
    harness: attestation.harness,
    source: attestation.source,
    providerId: attestation.providerId,
    modelId: attestation.modelId,
    reasoningEffort: attestation.reasoningEffort,
    roles: attestation.roles,
    limits: attestation.limits,
    policy: attestation.policy,
    environment: attestation.environment,
    baseRepositoryHash: attestation.baseRepositoryHash,
    caseHash: attestation.caseHash,
  };
  if (stableStringify(attestedArm) !== stableStringify(arm)) {
    fail(
      "attestation_mismatch",
      `Launch attestation for ${harness} does not match the sealed parity contract.`
    );
  }
}

async function executeArmsInOrder<T>(
  contract: HarnessParityContract,
  records: Readonly<Record<RobustBuildHarnessId, HarnessParityLaunchRecord<T>>>
): Promise<readonly PairedHarnessArmResult<T>[]> {
  const results: PairedHarnessArmResult<T>[] = [];
  for (const harness of contract.executionOrder) {
    const record = records[harness];
    const result = await record.callback(
      Object.freeze({
        harness,
        arm: contract.arms[harness],
        attestation: record.attestation,
        contract,
      })
    );
    results.push(
      Object.freeze({
        harness,
        attestation: record.attestation,
        result,
      })
    );
  }
  return Object.freeze(results);
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

function freezeAttestation(
  attestation: HarnessParityLaunchAttestation
): HarnessParityLaunchAttestation {
  const arm = freezeArm(attestation);
  return Object.freeze({
    schemaVersion: 1 as const,
    ...arm,
  });
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
