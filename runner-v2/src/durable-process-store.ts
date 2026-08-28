import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as nodeTypes } from "node:util";

import {
  assertDurableExecutionSafetyValue,
  parseExecutionSafetyCapabilities,
  parseProcessOutputDisposition,
  type ExecutionSafetyCapabilityName,
  type ProcessCleanupStatus,
  type ProcessEscalationAction,
  type ProcessOutputDisposition,
} from "./execution-safety-contracts.js";

export const DURABLE_SUBPROCESS_SCHEMA_VERSION = 2 as const;
export type DurableSubprocessState =
  | "prepared"
  | "launching"
  | "running"
  | "stopping"
  | "exited"
  | "verifying_empty"
  | "cleaned"
  | "launch_not_proven"
  | "orphaned"
  | "identity_mismatch"
  | "backend_unavailable"
  | "outcome_unknown"
  | "cleanup_blocked";
export interface DurableSubprocessHistoryEntry {
  readonly state: DurableSubprocessState;
  readonly at: string;
  readonly reason?: string;
}
export interface DurableEnvironmentAudit {
  readonly inheritedNames: readonly string[];
  readonly removedNames: readonly string[];
  readonly explicitSafeNames: readonly string[];
  readonly grantedNames: readonly string[];
}
export interface DurableBackendBinding {
  readonly registryId: string;
  readonly backendId: string;
  readonly implementationGeneration: string;
  readonly implementationDigest: string;
  readonly attestationVersion: number;
  readonly attestationDigest: string;
  readonly opaqueIdentity: string;
  readonly birthFingerprint: {
    readonly observedAt: string;
    readonly discriminator: string;
  };
  readonly rootPid?: number;
  readonly startedAt: string;
}
export interface DurableStopIntent {
  readonly reason: "cancelled" | "timed_out";
  readonly requestedAt: string;
}
export interface DurableEscalationEntry {
  readonly action: ProcessEscalationAction;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly outcome: "requested" | "running" | "exited" | "failed";
  readonly detail?: string;
}
export interface DurableChildObservation {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly observedAt: string;
}
export interface DurableOutputPrepareFailure {
  readonly failedAt: string;
  readonly detail: string;
}
export interface DurableSubprocessResult {
  readonly outcome:
    "exited" | "timed_out" | "cancelled" | "launch_failed" | "cleanup_failed";
  readonly exitCode?: number;
  readonly signal?: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
}

export interface DurableSubprocessRecord {
  readonly schemaVersion: typeof DURABLE_SUBPROCESS_SCHEMA_VERSION;
  readonly revision: number;
  readonly logicalProcessId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly requestFingerprint: string;
  readonly retryKey: string;
  readonly ownerId: string;
  readonly leaseExpiresAt: string;
  readonly outputOwnerId: string;
  readonly outputPrepared: boolean;
  readonly state: DurableSubprocessState;
  readonly history: readonly DurableSubprocessHistoryEntry[];
  readonly requiredCapabilities: readonly ExecutionSafetyCapabilityName[];
  readonly environmentAudit: DurableEnvironmentAudit;
  readonly escalation: readonly DurableEscalationEntry[];
  readonly cleanup: ProcessCleanupStatus;
  readonly backendBinding?: DurableBackendBinding;
  readonly stopIntent?: DurableStopIntent;
  readonly observation?: DurableChildObservation;
  readonly outputPrepareFailure?: DurableOutputPrepareFailure;
  readonly output?: readonly ProcessOutputDisposition[];
  readonly result?: DurableSubprocessResult;
}
export type PreparedSubprocessRecord = DurableSubprocessRecord & {
  readonly state: "prepared";
  readonly revision: 0;
};
export interface DurableClaimResult {
  readonly record: DurableSubprocessRecord;
  readonly won: boolean;
}

export type DurableProcessCommand =
  | {
      readonly type: "renew_lease";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly ownerId: string;
      readonly at: string;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly type: "takeover_lease";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly ownerId: string;
      readonly at: string;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly type: "mark_launching";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
    }
  | {
      readonly type: "mark_output_prepared";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
    }
  | {
      readonly type: "record_environment";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly environmentAudit: DurableEnvironmentAudit;
    }
  | {
      readonly type: "record_output_prepare_failure";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly detail: string;
    }
  | {
      readonly type: "bind_launch";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly binding: DurableBackendBinding;
    }
  | {
      readonly type: "adopt_backend";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly binding: DurableBackendBinding;
    }
  | {
      readonly type: "request_stop";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly reason: "cancelled" | "timed_out";
    }
  | {
      readonly type: "start_escalation";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly action: ProcessEscalationAction;
      readonly requestedAt: string;
    }
  | {
      readonly type: "finish_escalation";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly action: ProcessEscalationAction;
      readonly completedAt: string;
      readonly outcome: "running" | "exited" | "failed";
      readonly detail?: string;
    }
  | {
      readonly type: "record_exit";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly observation: DurableChildObservation;
    }
  | {
      readonly type: "begin_verify";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly output: readonly ProcessOutputDisposition[];
    }
  | {
      readonly type: "complete";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly cleanup: ProcessCleanupStatus;
      readonly result: DurableSubprocessResult;
    }
  | {
      readonly type: "fail_launch";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly detail: string;
    }
  | {
      readonly type: "fail";
      readonly invocationId: string;
      readonly expectedRevision: number;
      readonly at: string;
      readonly state:
        | "orphaned"
        | "identity_mismatch"
        | "backend_unavailable"
        | "outcome_unknown"
        | "cleanup_blocked";
      readonly detail: string;
      readonly cleanup?: ProcessCleanupStatus;
      readonly result?: DurableSubprocessResult;
      readonly output?: readonly ProcessOutputDisposition[];
    };

export interface DurableProcessRuntimeWriter {
  claim(record: PreparedSubprocessRecord): DurableClaimResult;
  apply(command: DurableProcessCommand): DurableSubprocessRecord;
}
export interface DurableProcessStore {
  readonly coordinationId: string;
  readByInvocation(invocationId: string): DurableSubprocessRecord | undefined;
  listRowIds(): string[];
  close(): void;
}
export interface DurableProcessStoreKernel {
  readonly store: DurableProcessStore;
}

export interface SemanticRequestFingerprintInput {
  readonly intent: unknown;
  readonly ambientEnvironment: unknown;
  readonly explicitEnvironment?: unknown;
  readonly credentialGrantId?: string;
  readonly grantId: string;
  readonly grantBindingDigest: string;
  readonly deadline?: string;
  readonly signalPresent: boolean;
  readonly signalInitiallyAborted: boolean;
}
export function semanticRequestFingerprint(
  key: Uint8Array,
  input: SemanticRequestFingerprintInput,
): string {
  return hmac(snapshotKey(key), canonicalJson(input));
}

const RUNTIME_WRITER = Symbol("runtime-writer");

abstract class AuthorityStore implements DurableProcessStore {
  abstract readonly coordinationId: string;
  constructor(protected readonly integrityKey: Uint8Array) {
    this.integrityKey = snapshotKey(integrityKey);
  }
  runtimeWriter(): DurableProcessRuntimeWriter {
    return Object.freeze({
      claim: (record: PreparedSubprocessRecord) => this.claim(record),
      apply: (command: DurableProcessCommand) => this.apply(command),
    });
  }
  protected abstract claim(
    record: PreparedSubprocessRecord,
  ): DurableClaimResult;
  protected abstract apply(
    command: DurableProcessCommand,
  ): DurableSubprocessRecord;
  abstract readByInvocation(
    invocationId: string,
  ): DurableSubprocessRecord | undefined;
  abstract listRowIds(): string[];
  abstract close(): void;
}

class InMemoryDurableProcessStore extends AuthorityStore {
  readonly coordinationId = `memory-${randomUUID()}`;
  private readonly records = new Map<string, DurableSubprocessRecord>();
  constructor(key: Uint8Array, initial: readonly unknown[] = []) {
    super(key);
    for (const value of initial) {
      const record = parseDurableSubprocessRecord(value);
      this.records.set(record.invocationId, record);
    }
  }
  protected claim(record: PreparedSubprocessRecord): DurableClaimResult {
    const parsed = parseDurableSubprocessRecord(record);
    const existing = this.records.get(parsed.invocationId);
    if (existing) {
      const claim = claimRetry(existing, parsed);
      if (claim.won) this.records.set(parsed.invocationId, claim.record);
      return claim;
    }
    this.records.set(parsed.invocationId, parsed);
    return Object.freeze({ record: cloneRecord(parsed), won: true });
  }
  protected apply(command: DurableProcessCommand): DurableSubprocessRecord {
    const current = requiredRecord(
      this.records.get(command.invocationId),
      command.invocationId,
    );
    const next = applyCommand(current, command);
    this.records.set(command.invocationId, next);
    return cloneRecord(next);
  }
  readByInvocation(id: string): DurableSubprocessRecord | undefined {
    const value = this.records.get(id);
    return value ? cloneRecord(value) : undefined;
  }
  listRowIds(): string[] {
    return [...this.records.keys()].sort();
  }
  close(): void {}
}

interface ProcessRow {
  invocation_id: string;
  revision: number;
  record_json: string;
  integrity?: string | null;
}
class SqliteDurableProcessStore extends AuthorityStore {
  readonly coordinationId: string;
  private readonly database: DatabaseSync;
  private readonly readOnly: boolean;
  constructor(
    path: string,
    key: Uint8Array,
    options: { readonly readOnly?: boolean } = {},
  ) {
    const readOnly = options.readOnly ?? false;
    super(key);
    this.coordinationId = `sqlite-${resolve(path).toLowerCase()}`;
    this.readOnly = readOnly;
    if (!readOnly) mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path, { readOnly });
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (!readOnly) this.migrateSchema();
  }
  protected claim(record: PreparedSubprocessRecord): DurableClaimResult {
    this.assertWritable();
    const parsed = parseDurableSubprocessRecord(record);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.readByInvocation(parsed.invocationId);
      if (existing) {
        const claim = claimRetry(existing, parsed);
        if (claim.won) {
          const json = JSON.stringify(claim.record);
          this.database
            .prepare(
              "UPDATE durable_processes SET revision=?, record_json=?, integrity=? WHERE invocation_id=? AND revision=?",
            )
            .run(
              claim.record.revision,
              json,
              this.sign(claim.record.invocationId, claim.record.revision, json),
              claim.record.invocationId,
              existing.revision,
            );
        }
        this.database.exec("COMMIT");
        return claim;
      }
      const json = JSON.stringify(parsed);
      this.database
        .prepare(
          "INSERT INTO durable_processes (invocation_id, revision, record_json, integrity) VALUES (?, ?, ?, ?)",
        )
        .run(
          parsed.invocationId,
          parsed.revision,
          json,
          this.sign(parsed.invocationId, parsed.revision, json),
        );
      this.database.exec("COMMIT");
      return Object.freeze({ record: cloneRecord(parsed), won: true });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  protected apply(command: DurableProcessCommand): DurableSubprocessRecord {
    this.assertWritable();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.readByInvocation(command.invocationId);
      if (!current)
        throw new Error(`Unknown process invocation ${command.invocationId}.`);
      const next = applyCommand(current, command);
      const json = JSON.stringify(next);
      const result = this.database
        .prepare(
          "UPDATE durable_processes SET revision = ?, record_json = ?, integrity = ? WHERE invocation_id = ? AND revision = ?",
        )
        .run(
          next.revision,
          json,
          this.sign(next.invocationId, next.revision, json),
          next.invocationId,
          current.revision,
        );
      if (result.changes !== 1)
        throw new Error(
          `Process revision conflict for ${command.invocationId}.`,
        );
      this.database.exec("COMMIT");
      return cloneRecord(next);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  readByInvocation(id: string): DurableSubprocessRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM durable_processes WHERE invocation_id = ?")
      .get(id) as ProcessRow | undefined;
    if (!row) return undefined;
    try {
      const expected = this.sign(
        row.invocation_id,
        row.revision,
        row.record_json,
      );
      if (!safeEqual(expected, row.integrity))
        throw new Error("integrity mismatch");
      return parseDurableSubprocessRecord(JSON.parse(row.record_json));
    } catch (error) {
      throw new Error(`Stored durable process record ${id} is corrupt.`, {
        cause: error,
      });
    }
  }
  listRowIds(): string[] {
    return (
      this.database
        .prepare(
          "SELECT invocation_id FROM durable_processes ORDER BY invocation_id",
        )
        .all() as unknown as Array<{ invocation_id: string }>
    ).map((row) => row.invocation_id);
  }
  close(): void {
    this.database.close();
  }
  private assertWritable(): void {
    if (this.readOnly) throw new Error("Durable process store is read-only.");
  }
  private sign(id: string, revision: number, json: string): string {
    return hmac(this.integrityKey, `${id}\0${revision}\0${json}`);
  }
  private migrateSchema(): void {
    this.database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    try {
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS durable_processes (invocation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL, integrity TEXT NOT NULL)",
      );
      const columns = new Set(
        (
          this.database
            .prepare("PRAGMA table_info(durable_processes)")
            .all() as unknown as Array<{ name: string }>
        ).map(({ name }) => name),
      );
      if (!columns.has("revision"))
        this.database.exec(
          "ALTER TABLE durable_processes ADD COLUMN revision INTEGER",
        );
      if (!columns.has("integrity"))
        this.database.exec(
          "ALTER TABLE durable_processes ADD COLUMN integrity TEXT",
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function kernelFor(store: AuthorityStore): DurableProcessStoreKernel {
  const publicStore = Object.freeze({
    coordinationId: store.coordinationId,
    readByInvocation: store.readByInvocation.bind(store),
    listRowIds: store.listRowIds.bind(store),
    close: store.close.bind(store),
  });
  const kernel = { store: publicStore };
  Object.defineProperty(kernel, RUNTIME_WRITER, {
    value: store.runtimeWriter(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(kernel);
}
export function createInMemoryDurableProcessKernel(
  key: Uint8Array,
  initial: readonly unknown[] = [],
): DurableProcessStoreKernel {
  return kernelFor(new InMemoryDurableProcessStore(key, initial));
}
export function openSqliteDurableProcessKernel(
  path: string,
  key: Uint8Array,
  options: { readonly readOnly?: boolean } = {},
): DurableProcessStoreKernel {
  return kernelFor(new SqliteDurableProcessStore(path, key, options));
}

const STATES = new Set<DurableSubprocessState>([
  "prepared",
  "launching",
  "running",
  "stopping",
  "exited",
  "verifying_empty",
  "cleaned",
  "launch_not_proven",
  "orphaned",
  "identity_mismatch",
  "backend_unavailable",
  "outcome_unknown",
  "cleanup_blocked",
]);
const LEGAL_HISTORY: Readonly<
  Record<DurableSubprocessState, readonly DurableSubprocessState[]>
> = {
  prepared: ["prepared", "launching", "launch_not_proven", "cleanup_blocked"],
  launching: [
    "launching",
    "running",
    "stopping",
    "launch_not_proven",
    "orphaned",
    "identity_mismatch",
    "backend_unavailable",
    "outcome_unknown",
  ],
  running: [
    "running",
    "stopping",
    "exited",
    "identity_mismatch",
    "backend_unavailable",
    "outcome_unknown",
  ],
  stopping: [
    "stopping",
    "exited",
    "identity_mismatch",
    "backend_unavailable",
    "outcome_unknown",
  ],
  exited: [
    "exited",
    "verifying_empty",
    "cleanup_blocked",
    "backend_unavailable",
    "outcome_unknown",
  ],
  verifying_empty: [
    "verifying_empty",
    "cleaned",
    "cleanup_blocked",
    "backend_unavailable",
    "outcome_unknown",
  ],
  backend_unavailable: [
    "exited",
    "stopping",
    "identity_mismatch",
    "outcome_unknown",
    "backend_unavailable",
  ],
  cleaned: [],
  launch_not_proven: [],
  orphaned: [],
  identity_mismatch: [],
  outcome_unknown: [],
  cleanup_blocked: [],
};
const BASE_KEYS = [
  "schemaVersion",
  "revision",
  "logicalProcessId",
  "invocationId",
  "runId",
  "taskId",
  "sessionId",
  "requestFingerprint",
  "retryKey",
  "ownerId",
  "leaseExpiresAt",
  "outputOwnerId",
  "outputPrepared",
  "state",
  "history",
  "requiredCapabilities",
  "environmentAudit",
  "escalation",
  "cleanup",
];
const OPTIONAL_BY_STATE: Record<DurableSubprocessState, readonly string[]> = {
  prepared: ["stopIntent", "outputPrepareFailure"],
  launching: ["stopIntent"],
  running: ["backendBinding"],
  stopping: ["backendBinding", "stopIntent"],
  exited: ["backendBinding", "stopIntent", "observation"],
  verifying_empty: ["backendBinding", "stopIntent", "observation", "output"],
  cleaned: ["backendBinding", "stopIntent", "observation", "output", "result"],
  launch_not_proven: ["result"],
  orphaned: ["stopIntent"],
  identity_mismatch: ["backendBinding", "stopIntent"],
  backend_unavailable: [
    "backendBinding",
    "stopIntent",
    "observation",
    "output",
  ],
  outcome_unknown: ["backendBinding", "stopIntent", "observation", "output"],
  cleanup_blocked: [
    "backendBinding",
    "stopIntent",
    "observation",
    "output",
    "result",
  ],
};

export function parseDurableSubprocessRecord(
  value: unknown,
): DurableSubprocessRecord {
  const object = strictRecord(value, "durable process record");
  const state = requiredEnum(object.state, STATES, "state");
  assertKeys(
    object,
    new Set([...BASE_KEYS, ...OPTIONAL_BY_STATE[state]]),
    "durable process record",
  );
  const record: DurableSubprocessRecord = {
    schemaVersion: requiredInteger(
      object.schemaVersion,
      "schemaVersion",
      2,
      2,
    ) as 2,
    revision: requiredInteger(object.revision, "revision", 0),
    logicalProcessId: text(object.logicalProcessId, "logicalProcessId"),
    invocationId: text(object.invocationId, "invocationId"),
    runId: text(object.runId, "runId"),
    ...optionalText(object, "taskId"),
    ...optionalText(object, "sessionId"),
    requestFingerprint: digest(object.requestFingerprint, "requestFingerprint"),
    retryKey: digest(object.retryKey, "retryKey"),
    ownerId: safeId(object.ownerId, "ownerId"),
    leaseExpiresAt: dateText(object.leaseExpiresAt, "leaseExpiresAt"),
    outputOwnerId: safeId(object.outputOwnerId, "outputOwnerId"),
    outputPrepared: requiredBoolean(object.outputPrepared, "outputPrepared"),
    state,
    history: parseHistory(object.history, state),
    requiredCapabilities: parseCapabilities(object.requiredCapabilities),
    environmentAudit: parseAudit(object.environmentAudit),
    escalation: parseEscalation(object.escalation),
    cleanup: parseCleanup(object.cleanup),
    ...(object.backendBinding === undefined
      ? {}
      : { backendBinding: parseBinding(object.backendBinding) }),
    ...(object.stopIntent === undefined
      ? {}
      : { stopIntent: parseStop(object.stopIntent) }),
    ...(object.observation === undefined
      ? {}
      : { observation: parseObservation(object.observation) }),
    ...(object.outputPrepareFailure === undefined
      ? {}
      : {
          outputPrepareFailure: parseOutputPrepareFailure(
            object.outputPrepareFailure,
          ),
        }),
    ...(object.output === undefined
      ? {}
      : { output: parseOutput(object.output) }),
    ...(object.result === undefined
      ? {}
      : { result: parseResult(object.result) }),
  };
  assertStateInvariants(record);
  assertDurableExecutionSafetyValue(record);
  return deepFreeze(structuredClone(record));
}

function applyCommand(
  current: DurableSubprocessRecord,
  command: DurableProcessCommand,
): DurableSubprocessRecord {
  if (command.expectedRevision !== current.revision)
    throw new Error(`Process revision conflict for ${current.invocationId}.`);
  let next: DurableSubprocessRecord;
  if (command.type === "renew_lease") {
    if (current.ownerId !== command.ownerId)
      throw new Error("Process lease owner mismatch.");
    next = {
      ...current,
      revision: current.revision + 1,
      leaseExpiresAt: dateText(command.leaseExpiresAt, "leaseExpiresAt"),
      history: [
        ...current.history,
        { state: current.state, at: command.at, reason: "lease_renewed" },
      ],
    };
  } else if (command.type === "takeover_lease") {
    if (Date.parse(current.leaseExpiresAt) > Date.parse(command.at))
      throw new Error("Process lease is still live.");
    next = {
      ...current,
      revision: current.revision + 1,
      ownerId: safeId(command.ownerId, "ownerId"),
      leaseExpiresAt: dateText(command.leaseExpiresAt, "leaseExpiresAt"),
      history: [
        ...current.history,
        { state: current.state, at: command.at, reason: "lease_takeover" },
      ],
    };
  } else if (command.type === "mark_output_prepared") {
    requireState(current, ["prepared"]);
    next = {
      ...current,
      revision: current.revision + 1,
      outputPrepared: true,
      outputPrepareFailure: undefined,
      history: [
        ...current.history,
        { state: "prepared", at: command.at, reason: "output_prepared" },
      ],
    };
  } else if (command.type === "record_environment") {
    requireState(current, ["prepared"]);
    if (!current.outputPrepared)
      throw new Error("Output ownership is not prepared.");
    next = {
      ...current,
      revision: current.revision + 1,
      environmentAudit: command.environmentAudit,
      history: [
        ...current.history,
        { state: "prepared", at: command.at, reason: "environment_prepared" },
      ],
    };
  } else if (command.type === "record_output_prepare_failure") {
    requireState(current, ["prepared"]);
    next = {
      ...current,
      revision: current.revision + 1,
      outputPrepareFailure: { failedAt: command.at, detail: command.detail },
      leaseExpiresAt: command.at,
      history: [
        ...current.history,
        { state: "prepared", at: command.at, reason: "output_prepare_failed" },
      ],
    };
  } else if (command.type === "mark_launching") {
    requireState(current, ["prepared"]);
    if (!current.outputPrepared)
      throw new Error("Output ownership is not prepared.");
    next = move(current, "launching", command.at);
  } else if (command.type === "bind_launch") {
    requireState(current, ["launching"]);
    next = move(
      { ...current, backendBinding: command.binding },
      current.stopIntent ? "stopping" : "running",
      command.at,
    );
  } else if (command.type === "adopt_backend") {
    requireState(current, [
      "running",
      "stopping",
      "exited",
      "verifying_empty",
      "backend_unavailable",
    ]);
    if (
      !current.backendBinding ||
      current.backendBinding.opaqueIdentity !==
        command.binding.opaqueIdentity ||
      current.backendBinding.birthFingerprint.discriminator !==
        command.binding.birthFingerprint.discriminator
    )
      throw new Error("Backend adoption cannot change process identity.");
    next = {
      ...current,
      backendBinding: command.binding,
      revision: current.revision + 1,
      history: [
        ...current.history,
        {
          state: current.state,
          at: command.at,
          reason: "backend_restart_adopted",
        },
      ],
    };
  } else if (command.type === "request_stop") {
    requireState(current, [
      "prepared",
      "launching",
      "running",
      "stopping",
      "backend_unavailable",
    ]);
    const stopIntent = current.stopIntent ?? {
      reason: command.reason,
      requestedAt: command.at,
    };
    const state =
      current.state === "running" || current.state === "backend_unavailable"
        ? "stopping"
        : current.state;
    next = {
      ...current,
      revision: current.revision + 1,
      stopIntent,
      state,
      history: [
        ...current.history,
        { state, at: command.at, reason: stopIntent.reason },
      ],
    };
  } else if (command.type === "start_escalation") {
    requireState(current, ["stopping"]);
    if (current.escalation.some((entry) => entry.outcome === "requested"))
      throw new Error("An escalation effect is already pending.");
    next = {
      ...current,
      revision: current.revision + 1,
      escalation: [
        ...current.escalation,
        {
          action: command.action,
          requestedAt: command.requestedAt,
          outcome: "requested",
        },
      ],
      history: [
        ...current.history,
        {
          state: "stopping",
          at: command.requestedAt,
          reason: `${command.action}_requested`,
        },
      ],
    };
  } else if (command.type === "finish_escalation") {
    requireState(current, ["stopping"]);
    const index = current.escalation.length - 1;
    const pending = current.escalation[index];
    if (
      !pending ||
      pending.outcome !== "requested" ||
      pending.action !== command.action
    )
      throw new Error("Escalation completion has no matching durable request.");
    const completed = {
      ...pending,
      completedAt: command.completedAt,
      outcome: command.outcome,
      ...(command.detail ? { detail: command.detail } : {}),
    };
    next = {
      ...current,
      revision: current.revision + 1,
      escalation: [...current.escalation.slice(0, index), completed],
      history: [
        ...current.history,
        {
          state: "stopping",
          at: command.completedAt,
          reason: `${command.action}_${command.outcome}`,
        },
      ],
    };
  } else if (command.type === "record_exit") {
    requireState(current, ["running", "stopping", "backend_unavailable"]);
    next = move(
      { ...current, observation: command.observation },
      "exited",
      command.at,
    );
  } else if (command.type === "begin_verify") {
    requireState(current, ["exited"]);
    next = move(
      { ...current, output: command.output },
      "verifying_empty",
      command.at,
    );
  } else if (command.type === "complete") {
    requireState(current, ["verifying_empty"]);
    next = move(
      { ...current, cleanup: command.cleanup, result: command.result },
      "cleaned",
      command.at,
    );
  } else if (command.type === "fail_launch") {
    requireState(current, ["prepared", "launching"]);
    next = move(
      {
        ...current,
        result: { outcome: "launch_failed", finishedAt: command.at },
        cleanup: { state: "not_required" },
      },
      "launch_not_proven",
      command.at,
      command.detail,
    );
  } else {
    requireState(current, [
      "prepared",
      "launching",
      "running",
      "stopping",
      "exited",
      "verifying_empty",
      "backend_unavailable",
    ]);
    next = move(
      {
        ...current,
        ...(command.cleanup ? { cleanup: command.cleanup } : {}),
        ...(command.result ? { result: command.result } : {}),
        ...(command.output ? { output: command.output } : {}),
      },
      command.state,
      command.at,
      command.detail,
    );
  }
  return parseDurableSubprocessRecord(next);
}
function move(
  current: DurableSubprocessRecord,
  state: DurableSubprocessState,
  at: string,
  reason?: string,
): DurableSubprocessRecord {
  return {
    ...current,
    revision: current.revision + 1,
    state,
    history: [...current.history, { state, at, ...(reason ? { reason } : {}) }],
  };
}
function compareRetry(
  existing: DurableSubprocessRecord,
  incoming: DurableSubprocessRecord,
): DurableSubprocessRecord {
  if (
    existing.requestFingerprint !== incoming.requestFingerprint ||
    existing.retryKey !== incoming.retryKey
  )
    throw new Error(
      `Process idempotency conflict for ${incoming.invocationId}.`,
    );
  return cloneRecord(existing);
}
function claimRetry(
  existing: DurableSubprocessRecord,
  incoming: DurableSubprocessRecord,
): DurableClaimResult {
  compareRetry(existing, incoming);
  const now = incoming.history[0]!.at;
  if (
    existing.state === "prepared" &&
    !existing.outputPrepared &&
    Date.parse(existing.leaseExpiresAt) <= Date.parse(now)
  ) {
    const record = parseDurableSubprocessRecord({
      ...existing,
      ownerId: incoming.ownerId,
      leaseExpiresAt: incoming.leaseExpiresAt,
      revision: existing.revision + 1,
      history: [
        ...existing.history,
        { state: "prepared", at: now, reason: "lease_takeover" },
      ],
    });
    return Object.freeze({ record, won: true });
  }
  return Object.freeze({ record: cloneRecord(existing), won: false });
}
function assertStateInvariants(record: DurableSubprocessRecord): void {
  if (
    record.history[0]?.state !== "prepared" ||
    record.history.length !== record.revision + 1
  )
    throw new Error("Durable process history/revision is invalid.");
  if (record.state !== "prepared" && !record.outputPrepared)
    throw new Error(
      "Durable process output must be prepared from launching onward.",
    );
  if (
    record.outputPrepareFailure &&
    (record.state !== "prepared" || record.outputPrepared)
  )
    throw new Error("Durable output prepare failure is inconsistent.");
  const needsBinding = [
    "running",
    "stopping",
    "exited",
    "verifying_empty",
    "cleaned",
  ].includes(record.state);
  if (needsBinding && !record.backendBinding)
    throw new Error(
      `Durable process record in ${record.state} requires backend binding.`,
    );
  if (
    record.backendBinding &&
    ![
      "running",
      "stopping",
      "exited",
      "verifying_empty",
      "cleaned",
      "identity_mismatch",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable process backend binding is inconsistent.");
  if (record.state === "stopping" && !record.stopIntent)
    throw new Error("Durable process record in stopping requires stop intent.");
  if (
    record.stopIntent &&
    ![
      "prepared",
      "launching",
      "running",
      "stopping",
      "exited",
      "verifying_empty",
      "cleaned",
      "identity_mismatch",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable stop intent is inconsistent.");
  if (
    ["exited", "verifying_empty", "cleaned"].includes(record.state) &&
    !record.observation
  )
    throw new Error(
      `Durable process record in ${record.state} requires observation.`,
    );
  if (
    record.observation &&
    ![
      "exited",
      "verifying_empty",
      "cleaned",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable observation is inconsistent.");
  if (["verifying_empty", "cleaned"].includes(record.state) && !record.output)
    throw new Error(
      `Durable process record in ${record.state} requires output.`,
    );
  if (
    record.output &&
    ![
      "verifying_empty",
      "cleaned",
      "backend_unavailable",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable output is inconsistent.");
  if (
    record.state === "cleaned" &&
    (!record.result ||
      record.cleanup.state !== "verified_empty" ||
      !resultMatches(record))
  )
    throw new Error(
      "Durable process record in cleaned requires consistent verified cleanup and result.",
    );
  if (
    record.state === "cleanup_blocked" &&
    (!record.result ||
      record.cleanup.state !== "failed" ||
      !resultMatches(record))
  )
    throw new Error(
      "Durable process record in cleanup_blocked requires consistent failed cleanup and result.",
    );
  if (
    record.state === "launch_not_proven" &&
    (record.result?.outcome !== "launch_failed" ||
      record.cleanup.state !== "not_required" ||
      record.observation)
  )
    throw new Error("Durable process record in launch_not_proven is invalid.");
  if (
    !["cleaned", "cleanup_blocked", "launch_not_proven"].includes(
      record.state,
    ) &&
    record.result
  )
    throw new Error(
      `Durable process record in ${record.state} cannot contain a result.`,
    );
  if (
    !["cleaned", "cleanup_blocked", "launch_not_proven"].includes(
      record.state,
    ) &&
    record.cleanup.state !== "pending"
  )
    throw new Error("Nonterminal durable process cleanup must be pending.");
  if (
    record.escalation.length > 0 &&
    ![
      "stopping",
      "exited",
      "verifying_empty",
      "cleaned",
      "backend_unavailable",
      "identity_mismatch",
      "outcome_unknown",
      "cleanup_blocked",
    ].includes(record.state)
  )
    throw new Error("Durable process escalation history is invalid.");
  const pending = record.escalation.filter(
    (entry) => entry.outcome === "requested",
  );
  if (
    pending.length > 1 ||
    record.escalation.length > 3 ||
    record.escalation.some(
      (entry, index) =>
        entry.action !== ["interrupt", "terminate", "force_terminate"][index],
    ) ||
    (record.escalation.length > 0 && !record.stopIntent)
  )
    throw new Error("Durable process escalation history is invalid.");
  validateHistory(record.history);
  if (record.history.at(-1)?.state !== record.state)
    throw new Error("Durable process history does not match current state.");
}
function parseHistory(
  value: unknown,
  _state: DurableSubprocessState,
): DurableSubprocessHistoryEntry[] {
  if (!Array.isArray(value) || value.length < 1)
    throw new Error("Durable process history is invalid.");
  return value.map((entry) => {
    const object = strictRecord(entry, "history entry");
    assertKeys(object, new Set(["state", "at", "reason"]), "history entry");
    return {
      state: requiredEnum(object.state, STATES, "history state"),
      at: text(object.at, "history at"),
      ...optionalText(object, "reason"),
    };
  });
}
function parseAudit(value: unknown): DurableEnvironmentAudit {
  const o = strictRecord(value, "environment audit");
  assertKeys(
    o,
    new Set([
      "inheritedNames",
      "removedNames",
      "explicitSafeNames",
      "grantedNames",
    ]),
    "environment audit",
  );
  return {
    inheritedNames: strings(o.inheritedNames),
    removedNames: strings(o.removedNames),
    explicitSafeNames: strings(o.explicitSafeNames),
    grantedNames: strings(o.grantedNames),
  };
}
function parseBinding(value: unknown): DurableBackendBinding {
  const o = strictRecord(value, "backend binding");
  assertKeys(
    o,
    new Set([
      "registryId",
      "backendId",
      "implementationGeneration",
      "implementationDigest",
      "attestationVersion",
      "attestationDigest",
      "opaqueIdentity",
      "birthFingerprint",
      "rootPid",
      "startedAt",
    ]),
    "backend binding",
  );
  const birth = strictRecord(o.birthFingerprint, "birth fingerprint");
  assertKeys(
    birth,
    new Set(["observedAt", "discriminator"]),
    "birth fingerprint",
  );
  return {
    registryId: safeId(o.registryId, "registryId"),
    backendId: text(o.backendId, "backendId"),
    implementationGeneration: safeId(
      o.implementationGeneration,
      "implementationGeneration",
    ),
    implementationDigest: digest(
      o.implementationDigest,
      "implementationDigest",
    ),
    attestationVersion: requiredInteger(
      o.attestationVersion,
      "attestationVersion",
      1,
    ),
    attestationDigest: digest(o.attestationDigest, "attestationDigest"),
    opaqueIdentity: text(o.opaqueIdentity, "opaqueIdentity"),
    birthFingerprint: {
      observedAt: text(birth.observedAt, "observedAt"),
      discriminator: text(birth.discriminator, "discriminator"),
    },
    ...(o.rootPid === undefined
      ? {}
      : { rootPid: requiredInteger(o.rootPid, "rootPid", 1) }),
    startedAt: text(o.startedAt, "startedAt"),
  };
}
function parseStop(value: unknown): DurableStopIntent {
  const o = strictRecord(value, "stop intent");
  assertKeys(o, new Set(["reason", "requestedAt"]), "stop intent");
  return {
    reason: requiredEnum(
      o.reason,
      new Set(["cancelled", "timed_out"]),
      "stop reason",
    ),
    requestedAt: text(o.requestedAt, "requestedAt"),
  };
}
function parseEscalation(value: unknown): DurableEscalationEntry[] {
  if (!Array.isArray(value)) throw new Error("Escalation history is invalid.");
  return value.map((entry) => {
    const o = strictRecord(entry, "escalation entry");
    assertKeys(
      o,
      new Set(["action", "requestedAt", "completedAt", "outcome", "detail"]),
      "escalation entry",
    );
    const outcome = requiredEnum(
      o.outcome,
      new Set<"requested" | "running" | "exited" | "failed">([
        "requested",
        "running",
        "exited",
        "failed",
      ]),
      "outcome",
    );
    if (outcome === "requested" && o.completedAt !== undefined)
      throw new Error("Requested escalation cannot already be completed.");
    if (outcome !== "requested" && o.completedAt === undefined)
      throw new Error("Completed escalation requires completion time.");
    return {
      action: requiredEnum(
        o.action,
        new Set(["interrupt", "terminate", "force_terminate"]),
        "action",
      ),
      requestedAt: text(o.requestedAt, "requestedAt"),
      ...(o.completedAt === undefined
        ? {}
        : { completedAt: text(o.completedAt, "completedAt") }),
      outcome,
      ...optionalText(o, "detail"),
    };
  });
}
function parseObservation(value: unknown): DurableChildObservation {
  const o = strictRecord(value, "observation");
  assertKeys(o, new Set(["exitCode", "signal", "observedAt"]), "observation");
  return {
    ...(o.exitCode === undefined
      ? {}
      : {
          exitCode: requiredInteger(
            o.exitCode,
            "exitCode",
            -2147483648,
            2147483647,
          ),
        }),
    ...optionalText(o, "signal"),
    observedAt: text(o.observedAt, "observedAt"),
  };
}
function parseOutputPrepareFailure(
  value: unknown,
): DurableOutputPrepareFailure {
  const o = strictRecord(value, "output prepare failure");
  assertKeys(o, new Set(["failedAt", "detail"]), "output prepare failure");
  return {
    failedAt: dateText(o.failedAt, "failedAt"),
    detail: text(o.detail, "detail"),
  };
}
function parseOutput(value: unknown): ProcessOutputDisposition[] {
  if (!Array.isArray(value)) throw new Error("Output is invalid.");
  return value.map((entry) => {
    const o = strictRecord(entry, "output disposition");
    assertKeys(
      o,
      new Set([
        "stream",
        "tail",
        "totalBytes",
        "truncated",
        "spillArtifactId",
        "spillBytes",
        "lossyBytes",
      ]),
      "output disposition",
    );
    return parseProcessOutputDisposition(o);
  });
}
function parseResult(value: unknown): DurableSubprocessResult {
  const o = strictRecord(value, "result");
  assertKeys(
    o,
    new Set(["outcome", "exitCode", "signal", "startedAt", "finishedAt"]),
    "result",
  );
  return {
    outcome: requiredEnum(
      o.outcome,
      new Set([
        "exited",
        "timed_out",
        "cancelled",
        "launch_failed",
        "cleanup_failed",
      ]),
      "result outcome",
    ),
    ...(o.exitCode === undefined
      ? {}
      : {
          exitCode: requiredInteger(
            o.exitCode,
            "exitCode",
            -2147483648,
            2147483647,
          ),
        }),
    ...optionalText(o, "signal"),
    ...optionalText(o, "startedAt"),
    finishedAt: text(o.finishedAt, "finishedAt"),
  };
}
function parseCleanup(value: unknown): ProcessCleanupStatus {
  const o = strictRecord(value, "cleanup");
  const state = requiredEnum(
    o.state,
    new Set<"not_required" | "pending" | "verified_empty" | "failed">([
      "not_required",
      "pending",
      "verified_empty",
      "failed",
    ]),
    "cleanup state",
  );
  if (state === "not_required") {
    assertKeys(o, new Set(["state"]), "cleanup");
    return { state: "not_required" };
  }
  if (state === "pending") {
    assertKeys(o, new Set(["state"]), "cleanup");
    return { state: "pending" };
  }
  if (state === "verified_empty") {
    assertKeys(
      o,
      new Set(["state", "verifiedAt", "proofArtifactId"]),
      "cleanup",
    );
    return {
      state: "verified_empty",
      verifiedAt: text(o.verifiedAt, "verifiedAt"),
      ...optionalText(o, "proofArtifactId"),
    };
  }
  assertKeys(o, new Set(["state", "failedAt", "code", "detail"]), "cleanup");
  return {
    state: "failed",
    failedAt: text(o.failedAt, "failedAt"),
    code: text(o.code, "code"),
    detail: text(o.detail, "detail"),
  };
}
function parseCapabilities(value: unknown): ExecutionSafetyCapabilityName[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error("Capabilities are invalid.");
  const all = {
    tree_termination: "enforced",
    crash_cleanup: "enforced",
    verified_emptiness: "enforced",
    write_confinement: "enforced",
  };
  parseExecutionSafetyCapabilities(all);
  const allowed = new Set(Object.keys(all));
  if (value.some((v) => !allowed.has(v as string)))
    throw new Error("Capabilities are invalid.");
  return [...value] as ExecutionSafetyCapabilityName[];
}
function strictRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  )
    throw new Error(`${label} is invalid.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new Error(`${label} is invalid.`);
  const desc = Object.getOwnPropertyDescriptors(value);
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(desc)) {
    if (typeof key !== "string" || !("value" in desc[key]!))
      throw new Error(`${label} is invalid.`);
    out[key] = desc[key]!.value;
  }
  return out;
}
function assertKeys(
  object: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const key = Object.keys(object).find((candidate) => !allowed.has(candidate));
  if (key) throw new Error(`${label} contains unknown field ${key}.`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} is invalid.`);
  return value;
}
function safeId(value: unknown, label: string): string {
  const v = text(value, label);
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(v))
    throw new Error(`${label} is invalid.`);
  return v;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}
function requiredInteger(
  value: unknown,
  label: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new Error(`${label} is invalid.`);
  return value as number;
}
function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}
function dateText(value: unknown, label: string): string {
  const valueText = text(value, label);
  if (Number.isNaN(Date.parse(valueText)))
    throw new Error(`${label} is invalid.`);
  return valueText;
}
function requiredEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T))
    throw new Error(`${label} is invalid.`);
  return value as T;
}
function optionalText<K extends string>(
  o: Record<string, unknown>,
  key: K,
): { [P in K]?: string } {
  return o[key] === undefined
    ? {}
    : ({ [key]: text(o[key], key) } as { [P in K]?: string });
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error("String list is invalid.");
  return [...value] as string[];
}
function requireState(
  record: DurableSubprocessRecord,
  states: readonly DurableSubprocessState[],
): void {
  if (!states.includes(record.state))
    throw new Error(`Illegal process transition from ${record.state}.`);
}
function validateHistory(
  history: readonly DurableSubprocessHistoryEntry[],
): void {
  for (let index = 1; index < history.length; index += 1) {
    const prior = history[index - 1]!.state;
    const next = history[index]!.state;
    if (!LEGAL_HISTORY[prior].includes(next))
      throw new Error(
        `Durable process history contains illegal transition ${prior} -> ${next}.`,
      );
  }
}
function requiredRecord(
  record: DurableSubprocessRecord | undefined,
  id: string,
): DurableSubprocessRecord {
  if (!record) throw new Error(`Unknown process invocation ${id}.`);
  return record;
}
function cloneRecord(record: DurableSubprocessRecord): DurableSubprocessRecord {
  return parseDurableSubprocessRecord(record);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function snapshotKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32)
    throw new Error("Runner state integrity key is invalid.");
  return new Uint8Array(key);
}
function hmac(key: Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
function safeEqual(left: string, right: unknown): boolean {
  if (typeof right !== "string" || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function resultMatches(record: DurableSubprocessRecord): boolean {
  const result = record.result!;
  if (record.stopIntent && result.outcome !== record.stopIntent.reason)
    return false;
  if (
    !record.stopIntent &&
    record.state === "cleaned" &&
    result.outcome !== "exited"
  )
    return false;
  if (
    record.observation?.exitCode !== result.exitCode ||
    record.observation?.signal !== result.signal
  )
    return false;
  if (record.backendBinding?.startedAt !== result.startedAt) return false;
  return true;
}
