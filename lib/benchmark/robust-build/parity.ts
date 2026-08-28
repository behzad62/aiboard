import {
  ROBUST_BUILD_HARNESS_IDS,
  type HarnessParityArm,
  type HarnessParityArmCallbacks,
  type HarnessParityContract,
  type HarnessParityLimits,
  type HarnessParityPolicy,
  type HarnessParityRole,
  type PairedHarnessArmResult,
  type RobustBuildHarnessId,
} from "./types";

/**
 * Resolved full commit for the plan's documented `b150a55` DeepSeek Harness
 * label (`dsh-v0.1.1-rc.2`). Abbreviated revisions are deliberately rejected.
 */
export const DEEPSEEK_HARNESS_SOURCE_REVISION =
  "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";

/** The immutable Runner V2 product revision evaluated by this benchmark. */
export const RUNNER_V2_PRODUCT_SOURCE_REVISION =
  "ec1ec8a110a77a0ad34a12ee60fa350583d4da2e";

export type HarnessParityErrorCode =
  | "invalid_contract"
  | "invalid_execution_order"
  | "invalid_source_revision"
  | "invalid_callbacks"
  | "missing_value"
  | "parity_mismatch";

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
  "sourceRevision",
  "providerId",
  "modelId",
  "reasoningEffort",
  "roles",
  "limits",
  "policy",
  "baseRepositoryHash",
  "caseHash",
] as const;
const ROLE_FIELDS = ["role", "available", "providerId", "modelId", "reasoningEffort"] as const;
const POLICY_FIELDS = ["permissions", "network"] as const;

/**
 * Parses a parity contract into a fresh immutable value. It is intentionally
 * strict: the benchmark cannot infer omitted values or silently tolerate
 * adapter-specific fields when determining whether two arms are comparable.
 */
export function createHarnessParityContract(input: unknown): HarnessParityContract {
  const raw = requireRecord(input, "contract");
  assertExactKeys(raw, CONTRACT_KEYS, "contract");
  if (raw.schemaVersion !== 1) {
    fail("invalid_contract", "Harness parity contract schemaVersion must be 1.");
  }

  const requiredRoles = parseRequiredRoles(raw.requiredRoles);
  const executionOrder = parseExecutionOrder(raw.executionOrder);
  const rawArms = requireRecord(raw.arms, "contract.arms");
  assertExactKeys(rawArms, ARM_KEYS, "contract.arms");

  const deepseek = parseArm(
    rawArms["deepseek-harness"],
    "deepseek-harness",
    DEEPSEEK_HARNESS_SOURCE_REVISION,
    requiredRoles
  );
  const runner = parseArm(
    rawArms["runner-v2"],
    "runner-v2",
    RUNNER_V2_PRODUCT_SOURCE_REVISION,
    requiredRoles
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
 * A collision-free canonical identity for the full contract. Role and
 * permission sets are sorted during parsing; paired execution order remains
 * ordered because counterbalancing is an auditable part of the run.
 */
export function canonicalHarnessParityIdentity(input: unknown): string {
  return `robust-build-parity-v1:${stableStringify(createHarnessParityContract(input))}`;
}

/**
 * Validates the entire pair and both callbacks before invoking either arm.
 * This is deliberately synchronous so an invalid or incomplete contract can
 * never start a model-call callback and cannot produce a partial paired run.
 */
export function beginParityValidatedHarnessArms<T>(
  input: unknown,
  callbacks: HarnessParityArmCallbacks<T>
): readonly PairedHarnessArmResult<T>[] {
  const contract = createHarnessParityContract(input);
  const callbackRecord = requireRecord(callbacks, "callbacks", "invalid_callbacks");
  assertExactKeys(
    callbackRecord,
    ARM_KEYS,
    "callbacks",
    "invalid_callbacks",
    "invalid_callbacks"
  );

  const validatedCallbacks = {} as Record<
    RobustBuildHarnessId,
    HarnessParityArmCallbacks<T>[RobustBuildHarnessId]
  >;
  for (const harness of ARM_KEYS) {
    const callback = callbackRecord[harness];
    if (typeof callback !== "function") {
      fail("invalid_callbacks", `Harness parity callbacks must include ${harness}.`);
    }
    validatedCallbacks[harness] = callback as HarnessParityArmCallbacks<T>[RobustBuildHarnessId];
  }

  const results = contract.executionOrder.map((harness) =>
    Object.freeze({
      harness,
      result: validatedCallbacks[harness]({
        harness,
        arm: contract.arms[harness],
        contract,
      }),
    })
  );
  return Object.freeze(results);
}

function parseArm(
  input: unknown,
  expectedHarness: RobustBuildHarnessId,
  expectedSourceRevision: string,
  requiredRoles: readonly string[]
): HarnessParityArm {
  const raw = requireRecord(input, `contract.arms.${expectedHarness}`);
  assertExactKeys(raw, ARM_FIELDS, `contract.arms.${expectedHarness}`);

  const harness = parseHarnessId(raw.harness, `contract.arms.${expectedHarness}.harness`);
  if (harness !== expectedHarness) {
    fail(
      "invalid_contract",
      `Harness parity arm ${expectedHarness} reported harness identity ${harness}.`
    );
  }

  const sourceRevision = requireRevision(
    raw.sourceRevision,
    `contract.arms.${expectedHarness}.sourceRevision`
  );
  if (sourceRevision !== expectedSourceRevision) {
    fail(
      "invalid_source_revision",
      `${expectedHarness} source revision must equal its exact pinned source revision.`
    );
  }

  return {
    harness,
    sourceRevision,
    providerId: requireText(raw.providerId, `contract.arms.${expectedHarness}.providerId`),
    modelId: requireText(raw.modelId, `contract.arms.${expectedHarness}.modelId`),
    reasoningEffort: requireText(
      raw.reasoningEffort,
      `contract.arms.${expectedHarness}.reasoningEffort`
    ),
    roles: parseRoles(raw.roles, expectedHarness, requiredRoles),
    limits: parseLimits(raw.limits, expectedHarness),
    policy: parsePolicy(raw.policy, expectedHarness),
    baseRepositoryHash: requireHash(
      raw.baseRepositoryHash,
      `contract.arms.${expectedHarness}.baseRepositoryHash`
    ),
    caseHash: requireHash(raw.caseHash, `contract.arms.${expectedHarness}.caseHash`),
  };
}

function parseRequiredRoles(input: unknown): readonly string[] {
  const roles = requireArray(input, "contract.requiredRoles");
  if (roles.length === 0) {
    fail("missing_value", "Harness parity contract requires at least one required role.");
  }
  return normalizeUniqueTexts(roles, "contract.requiredRoles");
}

function parseExecutionOrder(
  input: unknown
): readonly [RobustBuildHarnessId, RobustBuildHarnessId] {
  const order = requireArray(input, "contract.executionOrder");
  if (order.length !== ARM_KEYS.length) {
    fail("invalid_execution_order", "Harness parity execution order must contain exactly two arms.");
  }
  const first = parseHarnessId(order[0], "contract.executionOrder[0]");
  const second = parseHarnessId(order[1], "contract.executionOrder[1]");
  if (first === second || !ARM_KEYS.includes(first) || !ARM_KEYS.includes(second)) {
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
  requiredRoles: readonly string[]
): readonly HarnessParityRole[] {
  const values = requireArray(input, `contract.arms.${harness}.roles`);
  if (values.length !== requiredRoles.length) {
    fail(
      "missing_value",
      `Harness parity arm ${harness} must report every required role exactly once.`
    );
  }

  const roles = values.map((value, index) => {
    const path = `contract.arms.${harness}.roles[${index}]`;
    const raw = requireRecord(value, path);
    assertExactKeys(raw, ROLE_FIELDS, path);
    const available = raw.available;
    if (typeof available !== "boolean") {
      fail("missing_value", `${path}.available must be reported as a boolean.`);
    }
    return {
      role: requireText(raw.role, `${path}.role`),
      available,
      providerId: requireText(raw.providerId, `${path}.providerId`),
      modelId: requireText(raw.modelId, `${path}.modelId`),
      reasoningEffort: requireText(raw.reasoningEffort, `${path}.reasoningEffort`),
    };
  });
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

function parseLimits(input: unknown, harness: RobustBuildHarnessId): HarnessParityLimits {
  const path = `contract.arms.${harness}.limits`;
  const raw = requireRecord(input, path);
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

function parsePolicy(input: unknown, harness: RobustBuildHarnessId): HarnessParityPolicy {
  const path = `contract.arms.${harness}.policy`;
  const raw = requireRecord(input, path);
  assertExactKeys(raw, POLICY_FIELDS, path);
  return {
    permissions: normalizeUniqueTexts(
      requireArray(raw.permissions, `${path}.permissions`),
      `${path}.permissions`
    ),
    network: requireText(raw.network, `${path}.network`),
  };
}

function assertArmsHaveParity(
  deepseek: HarnessParityArm,
  runner: HarnessParityArm
): void {
  assertSame(deepseek.providerId, runner.providerId, "providerId");
  assertSame(deepseek.modelId, runner.modelId, "modelId");
  assertSame(deepseek.reasoningEffort, runner.reasoningEffort, "reasoningEffort");
  if (stableStringify(deepseek.roles) !== stableStringify(runner.roles)) {
    fail("parity_mismatch", "Harness parity mismatch: role mapping differs between arms.");
  }
  for (const key of LIMIT_KEYS) {
    assertSame(deepseek.limits[key], runner.limits[key], key);
  }
  if (stableStringify(deepseek.policy.permissions) !== stableStringify(runner.policy.permissions)) {
    fail("parity_mismatch", "Harness parity mismatch: permissions differ between arms.");
  }
  assertSame(deepseek.policy.network, runner.policy.network, "network policy");
  assertSame(deepseek.baseRepositoryHash, runner.baseRepositoryHash, "baseRepositoryHash");
  assertSame(deepseek.caseHash, runner.caseHash, "caseHash");
}

function assertSame(left: unknown, right: unknown, field: string): void {
  if (left !== right) {
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

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail("missing_value", `${path} must be reported as an array.`);
  }
  return value;
}

function requireRecord(
  value: unknown,
  path: string,
  code: HarnessParityErrorCode = "missing_value"
): UnknownRecord {
  if (!isPlainRecord(value)) {
    fail(code, `${path} must be a plain object.`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      fail(invalidCode, `${path}.${key} is not part of the parity contract schema.`);
    }
  }
}

function normalizeUniqueTexts(values: unknown[], path: string): readonly string[] {
  const normalized = values.map((value, index) => requireText(value, `${path}[${index}]`));
  const sorted = [...normalized].sort(compareText);
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
  const deepseek = freezeArm(input.arms["deepseek-harness"]);
  const runner = freezeArm(input.arms["runner-v2"]);
  return Object.freeze({
    schemaVersion: 1 as const,
    requiredRoles: Object.freeze([...input.requiredRoles]),
    executionOrder: Object.freeze([
      input.executionOrder[0],
      input.executionOrder[1],
    ]) as unknown as readonly [RobustBuildHarnessId, RobustBuildHarnessId],
    arms: Object.freeze({
      "deepseek-harness": deepseek,
      "runner-v2": runner,
    }),
  });
}

function freezeArm(arm: HarnessParityArm): HarnessParityArm {
  return Object.freeze({
    harness: arm.harness,
    sourceRevision: arm.sourceRevision,
    providerId: arm.providerId,
    modelId: arm.modelId,
    reasoningEffort: arm.reasoningEffort,
    roles: Object.freeze(
      arm.roles.map((role) =>
        Object.freeze({
          role: role.role,
          available: role.available,
          providerId: role.providerId,
          modelId: role.modelId,
          reasoningEffort: role.reasoningEffort,
        })
      )
    ),
    limits: Object.freeze({ ...arm.limits }),
    policy: Object.freeze({
      permissions: Object.freeze([...arm.policy.permissions]),
      network: arm.policy.network,
    }),
    baseRepositoryHash: arm.baseRepositoryHash,
    caseHash: arm.caseHash,
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as UnknownRecord;
  return `{${Object.keys(record)
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
