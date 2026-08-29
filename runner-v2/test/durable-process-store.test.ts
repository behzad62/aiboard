import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createInMemoryDurableProcessKernel,
  openSqliteDurableProcessKernel,
  semanticRequestFingerprint,
  parseDurableSubprocessRecord,
  type DurableProcessStoreKernel,
  type DurableProcessRuntimeWriter,
  type DurableSubprocessRecord,
  type PreparedSubprocessClaim,
} from "../src/durable-process-store.js";

const stateKey = new Uint8Array(32).fill(7);
const semantic = {
  intent: {
    runId: "run-1",
    invocationId: "invoke-1",
    kind: "command",
    executable: "tool",
    arguments: ["--token=secret-value"],
    workingDirectory: "C:\\host\\project",
    requestedCapabilities: ["verified_emptiness"],
  },
  ambientEnvironment: { API_KEY: "secret-value", PATH: "safe" },
  grantId: "grant-1",
  grantBindingDigest: "b".repeat(64),
  deadline: "2026-01-01T01:00:00.000Z",
  signalPresent: false,
  signalInitiallyAborted: false,
} as const;
const fingerprint = semanticRequestFingerprint(stateKey, semantic);
const prepared = (
  overrides: Partial<PreparedSubprocessClaim> = {},
): PreparedSubprocessClaim => ({
  schemaVersion: 2,
  revision: 0,
  logicalProcessId: "proc-1",
  invocationId: "invoke-1",
  runId: "run-1",
  requestFingerprint: fingerprint,
  retryKey: fingerprint,
  ownerId: "owner-1",
  leaseExpiresAt: "2026-01-01T00:05:00.000Z",
  outputOwnerId: "output-proc-1",
  outputPrepared: false,
  state: "prepared",
  history: [{ state: "prepared", at: "2026-01-01T00:00:00.000Z" }],
  requiredCapabilities: ["verified_emptiness"],
  environmentAudit: {
    inheritedNames: [],
    removedNames: [],
    explicitSafeNames: [],
    grantedNames: [],
  },
  escalation: [],
  cleanup: { state: "pending" },
  ...overrides,
});
function writerFor(kernel: DurableProcessStoreKernel): {
  claim: DurableProcessRuntimeWriter["claim"];
  apply(command: Record<string, unknown>): DurableSubprocessRecord;
} {
  for (const key of Object.getOwnPropertySymbols(kernel)) {
    const value = Object.getOwnPropertyDescriptor(kernel, key)?.value as
      DurableProcessRuntimeWriter | undefined;
    if (
      value &&
      typeof value.claim === "function" &&
      typeof value.apply === "function"
    )
      return {
        claim: value.claim,
        apply: (command) => {
          const invocationId = command.invocationId as string;
          const current = kernel.store.readByInvocation(invocationId);
          if (!current) throw new Error(`Unknown process ${invocationId}.`);
          return value.apply({
            ...command,
            ownerId: command.ownerId ?? current.ownerId,
            fencingToken: command.fencingToken ?? current.fencingToken,
          } as never);
        },
      };
  }
  throw new Error("missing test writer");
}

test("Runner-created store kernel rejects structural authority and claims output intent durably", () => {
  const kernel = createInMemoryDurableProcessKernel(stateKey);
  writerFor(kernel).claim(prepared());
  assert.throws(
    () => writerFor({ store: kernel.store } as never),
    /missing test writer/i,
  );
  assert.equal(
    kernel.store.readByInvocation("invoke-1")?.outputOwnerId,
    "output-proc-1",
  );
});

test("strict per-state parser rejects forged prepared completion and illegal state fields", () => {
  const base = writerFor(createInMemoryDurableProcessKernel(stateKey)).claim(
    prepared(),
  ).record;
  const forged = {
    ...base,
    result: { outcome: "exited", finishedAt: "x" },
    backendBinding: {
      registryId: "r",
      backendId: "b",
      attestationVersion: 1,
      attestationDigest: "b".repeat(64),
      opaqueIdentity: "o",
      birthFingerprint: { observedAt: "x", discriminator: "d" },
    },
  };
  assert.throws(
    () => parseDurableSubprocessRecord(forged),
    /durable process record|prepared/i,
  );
  assert.throws(
    () => parseDurableSubprocessRecord({ ...base, unknown: true }),
    /unknown field/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...base,
        cleanup: { state: "verified_empty", verifiedAt: "x" },
      }),
    /durable process record|prepared|cleanup|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...base,
        state: "backend_unavailable",
        history: [...base.history, { state: "backend_unavailable", at: "x" }],
        result: { outcome: "exited", finishedAt: "x" },
      }),
    /cannot contain a result|unknown field/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...base,
        state: "cleaned",
        history: [...base.history, { state: "cleaned", at: "x" }],
      }),
    /illegal transition|requires|history|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...base,
        revision: 2,
        outputPrepared: true,
        state: "running",
        history: [
          ...base.history,
          { state: "launching", at: "b" },
          { state: "running", at: "c" },
        ],
        backendBinding: {
          registryId: "registry",
          backendId: "fake",
          implementationGeneration: "generation",
          implementationDigest: "d".repeat(64),
          attestationVersion: 1,
          attestationDigest: "b".repeat(64),
          opaqueIdentity: "",
          birthFingerprint: { observedAt: "c", discriminator: "birth" },
          rootPid: 42,
          startedAt: "c",
        },
      }),
    /opaqueIdentity|invalid/i,
  );
});

test("closed mutation log is the sole authority for prepared and terminal row facts", () => {
  const kernel = createInMemoryDurableProcessKernel(stateKey);
  const writer = writerFor(kernel);
  const claimed = writer.claim(prepared()).record;
  assert.deepEqual(
    claimed.mutations.map((entry) => (entry as { readonly kind: string }).kind),
    ["prepared"],
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...claimed,
        outputPrepared: true,
        environmentAudit: {
          inheritedNames: ["FORGED"],
          removedNames: [],
          explicitSafeNames: [],
          grantedNames: [],
        },
      }),
    /mutation|derived|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...claimed,
        revision: 1,
        history: [
          ...claimed.history,
          {
            state: "prepared",
            at: "2026-01-01T00:00:01.000Z",
            reason: "forged_duplicate",
          },
        ],
        mutations: [
          ...claimed.mutations,
          {
            ...claimed.mutations[0],
            revision: 1,
            at: "2026-01-01T00:00:01.000Z",
          },
        ],
      }),
    /prepared mutation|mutation.*invalid|sequence/i,
  );

  let record = writer.apply({
    type: "mark_output_prepared",
    invocationId: "invoke-1",
    expectedRevision: claimed.revision,
    at: "2026-01-01T00:00:01.000Z",
  });
  record = writer.apply({
    type: "record_environment",
    invocationId: "invoke-1",
    expectedRevision: record.revision,
    at: "2026-01-01T00:00:02.000Z",
    environmentAudit: {
      inheritedNames: ["PATH"],
      removedNames: [],
      explicitSafeNames: [],
      grantedNames: [],
    },
  });
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...record,
        leaseExpiresAt: "2099-01-01T00:00:00.000Z",
      }),
    /mutation|derived|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...record,
        history: record.history.map((entry, index) =>
          index === 1 ? { ...entry, reason: "forged_kind" } : entry,
        ),
      }),
    /mutation|derived|projection/i,
  );
});

test("monotonic fencing rejects a stale owner even after it rereads the new revision", () => {
  const kernel = createInMemoryDurableProcessKernel(stateKey);
  const writer = writerFor(kernel);
  const initial = writer.claim(prepared()).record as DurableSubprocessRecord & {
    readonly fencingToken?: number;
  };
  assert.equal(initial.fencingToken, 1);
  const taken = writer.apply({
    type: "takeover_lease",
    invocationId: "invoke-1",
    expectedRevision: initial.revision,
    ownerId: "owner-2",
    fencingToken: 2,
    at: "2026-01-01T00:06:00.000Z",
    leaseExpiresAt: "2026-01-01T00:11:00.000Z",
  } as never) as typeof initial;
  assert.equal(taken.fencingToken, 2);
  assert.throws(
    () =>
      writer.apply({
        type: "mark_output_prepared",
        invocationId: "invoke-1",
        expectedRevision: taken.revision,
        ownerId: "owner-1",
        fencingToken: 1,
        at: "2026-01-01T00:06:01.000Z",
      } as never),
    /owner|fenc/i,
  );
});

test("blocked-exit recovery mutation is authenticated and scoped only to bound cleanup blockers", () => {
  const kernel = createInMemoryDurableProcessKernel(stateKey);
  const writer = writerFor(kernel);
  let record = writer.claim(prepared()).record;
  for (const command of [
    { type: "mark_output_prepared", at: "2026-01-01T00:00:01.000Z" },
    {
      type: "record_environment",
      at: "2026-01-01T00:00:02.000Z",
      environmentAudit: {
        inheritedNames: [],
        removedNames: [],
        explicitSafeNames: [],
        grantedNames: [],
      },
    },
    { type: "mark_launching", at: "2026-01-01T00:00:03.000Z" },
  ]) record = writer.apply({ ...command, invocationId: "invoke-1", expectedRevision: record.revision });
  record = writer.apply({
    type: "bind_launch",
    invocationId: "invoke-1",
    expectedRevision: record.revision,
    at: "2026-01-01T00:00:04.000Z",
    binding: {
      registryId: "registry",
      backendId: "fake",
      implementationGeneration: "generation",
      implementationDigest: "b".repeat(64),
      attestationVersion: 1,
      attestationDigest: "c".repeat(64),
      opaqueIdentity: "identity",
      birthFingerprint: { observedAt: "2026-01-01T00:00:04.000Z", discriminator: "birth" },
      startedAt: "2026-01-01T00:00:04.000Z",
    },
  });
  assert.throws(() => writer.apply({
    type: "resume_blocked_exit",
    invocationId: "invoke-1",
    expectedRevision: record.revision,
    at: "2026-01-01T00:00:05.000Z",
    observation: { exitCode: 0, observedAt: "2026-01-01T00:00:05.000Z" },
  }), /illegal.*running|cleanup_blocked/i);
  record = writer.apply({
    type: "fail",
    invocationId: "invoke-1",
    expectedRevision: record.revision,
    at: "2026-01-01T00:00:05.000Z",
    state: "cleanup_blocked",
    detail: "owned process remains",
    cleanup: {
      state: "failed",
      failedAt: "2026-01-01T00:00:05.000Z",
      code: "launch_cleanup_blocked",
      detail: "owned process remains",
    },
    result: {
      outcome: "cleanup_failed",
      startedAt: "2026-01-01T00:00:04.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z",
    },
  });
  assert.throws(() => writer.apply({
    type: "resume_blocked_exit",
    invocationId: "invoke-1",
    expectedRevision: record.revision,
    ownerId: "owner-stale",
    fencingToken: record.fencingToken,
    at: "2026-01-01T00:00:06.000Z",
    observation: { exitCode: 0, observedAt: "2026-01-01T00:00:06.000Z" },
  }), /owner|fenc/i);
  record = writer.apply({
    type: "resume_blocked_exit",
    invocationId: "invoke-1",
    expectedRevision: record.revision,
    at: "2026-01-01T00:00:06.000Z",
    observation: { exitCode: 0, observedAt: "2026-01-01T00:00:06.000Z" },
  });
  assert.equal(record.state, "exited");
  assert.equal(record.result, undefined);
  assert.deepEqual(record.cleanup, { state: "pending" });
  assert.equal(record.mutations.at(-1)?.kind, "resume_blocked_exit");
});

test("terminal parser cross-validates history revision observation stop result escalation and cleanup", () => {
  const kernel = createInMemoryDurableProcessKernel(stateKey);
  const writer = writerFor(kernel);
  const preparedBase = writer.claim(prepared()).record;
  let valid = preparedBase;
  valid = writer.apply({
    type: "mark_output_prepared",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:01.000Z",
  });
  valid = writer.apply({
    type: "record_environment",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:02.000Z",
    environmentAudit: {
      inheritedNames: ["PATH"],
      removedNames: [],
      explicitSafeNames: [],
      grantedNames: [],
    },
  });
  valid = writer.apply({
    type: "mark_launching",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:03.000Z",
  });
  valid = writer.apply({
    type: "bind_launch",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:04.000Z",
    binding: {
      registryId: "registry",
      backendId: "fake",
      implementationGeneration: "generation",
      implementationDigest: "b".repeat(64),
      attestationVersion: 1,
      attestationDigest: "c".repeat(64),
      opaqueIdentity: "identity",
      birthFingerprint: {
        observedAt: "2026-01-01T00:00:04.000Z",
        discriminator: "birth",
      },
      startedAt: "2026-01-01T00:00:04.000Z",
    },
  });
  valid = writer.apply({
    type: "record_exit",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:05.000Z",
    observation: {
      exitCode: 0,
      observedAt: "2026-01-01T00:00:05.000Z",
    },
  });
  const output = [
    {
      stream: "stdout" as const,
      tail: "",
      totalBytes: 0,
      truncated: false,
      spillBytes: 0,
      lossyBytes: 0,
    },
    {
      stream: "stderr" as const,
      tail: "",
      totalBytes: 0,
      truncated: false,
      spillBytes: 0,
      lossyBytes: 0,
    },
  ];
  valid = writer.apply({
    type: "begin_verify",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:06.000Z",
    output,
  });
  valid = writer.apply({
    type: "complete",
    invocationId: "invoke-1",
    expectedRevision: valid.revision,
    at: "2026-01-01T00:00:07.000Z",
    cleanup: {
      state: "verified_empty",
      verifiedAt: "2026-01-01T00:00:07.000Z",
    },
    result: {
      outcome: "exited",
      exitCode: 0,
      startedAt: "2026-01-01T00:00:04.000Z",
      finishedAt: "2026-01-01T00:00:07.000Z",
    },
  });
  assert.doesNotThrow(() => parseDurableSubprocessRecord(valid));
  assert.throws(
    () => parseDurableSubprocessRecord({ ...valid, outputPrepared: false }),
    /output.*prepared|projection/i,
  );
  assert.throws(
    () => parseDurableSubprocessRecord({ ...valid, revision: 5 }),
    /history|revision|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...valid,
        history: [{ state: "running", at: "a" }, ...valid.history.slice(1)],
      }),
    /history|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...valid,
        result: { ...valid.result, exitCode: 9 },
      }),
    /consistent|invalid|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...valid,
        stopIntent: { reason: "cancelled", requestedAt: "d" },
      }),
    /consistent|invalid|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...preparedBase,
        escalation: [
          {
            action: "interrupt",
            requestedAt: "a",
            completedAt: "b",
            outcome: "running",
          },
        ],
      }),
    /escalation|projection/i,
  );
  assert.throws(
    () =>
      parseDurableSubprocessRecord({
        ...preparedBase,
        stopIntent: { reason: "cancelled", requestedAt: "a" },
        escalation: [
          {
            action: "interrupt",
            requestedAt: "a",
            completedAt: "b",
            outcome: "running",
          },
        ],
      }),
    /escalation|projection/i,
  );
});

test("keyed semantic fingerprint covers environment and deadline without dictionary-guessable SHA", () => {
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint.includes("secret-value"), false);
  assert.notEqual(
    semanticRequestFingerprint(stateKey, {
      ...semantic,
      ambientEnvironment: { ...semantic.ambientEnvironment, API_KEY: "other" },
    }),
    fingerprint,
  );
  assert.notEqual(
    semanticRequestFingerprint(stateKey, { ...semantic, signalPresent: true }),
    fingerprint,
  );
  assert.notEqual(
    semanticRequestFingerprint(stateKey, {
      ...semantic,
      deadline: "2026-01-01T02:00:00.000Z",
    }),
    fingerprint,
  );
  assert.notEqual(
    semanticRequestFingerprint(new Uint8Array(32).fill(8), semantic),
    fingerprint,
  );
});

test("exact prepare retries converge while divergent retries and stale CAS commands conflict", () => {
  const kernel = createInMemoryDurableProcessKernel(stateKey);
  const writer = writerFor(kernel);
  assert.equal(writer.claim(prepared()).won, true);
  assert.equal(
    writer.claim(prepared({ logicalProcessId: "proc-retry" })).record
      .logicalProcessId,
    "proc-1",
  );
  assert.throws(
    () => writer.claim(prepared({ requestFingerprint: "c".repeat(64) })),
    /idempotency conflict/i,
  );
  writer.apply({
    type: "mark_output_prepared",
    invocationId: "invoke-1",
    expectedRevision: 0,
    at: "2026-01-01T00:00:00.500Z",
  });
  writer.apply({
    type: "record_environment",
    invocationId: "invoke-1",
    expectedRevision: 1,
    at: "2026-01-01T00:00:00.600Z",
    environmentAudit: {
      inheritedNames: ["PATH"],
      removedNames: ["API_KEY"],
      explicitSafeNames: [],
      grantedNames: [],
    },
  });
  const launching = writer.apply({
    type: "mark_launching",
    invocationId: "invoke-1",
    expectedRevision: 2,
    at: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(launching.revision, 3);
  assert.throws(
    () =>
      writer.apply({
        type: "fail_launch",
        invocationId: "invoke-1",
        expectedRevision: 0,
        at: "x",
        detail: "stale",
      }),
    /revision conflict/i,
  );
});

test("SQLite prepare is atomic across concurrent store instances and divergent requests conflict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite");
  const first = openSqliteDurableProcessKernel(path, stateKey);
  const second = openSqliteDurableProcessKernel(path, stateKey);
  const [left, right] = await Promise.all([
    Promise.resolve(writerFor(first).claim(prepared())),
    Promise.resolve(
      writerFor(second).claim(prepared({ logicalProcessId: "other-attempt" })),
    ),
  ]);
  assert.equal(left.record.logicalProcessId, right.record.logicalProcessId);
  assert.notEqual(left.won, right.won);
  assert.throws(
    () =>
      writerFor(second).claim(prepared({ requestFingerprint: "d".repeat(64) })),
    /idempotency conflict/i,
  );
  first.store.close();
  second.store.close();
});

test("SQLite corruption fails closed on reopen instead of returning a forged cached result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite");
  const kernel = openSqliteDurableProcessKernel(path, stateKey);
  writerFor(kernel).claim(prepared());
  kernel.store.close();
  const raw = new DatabaseSync(path);
  const row = raw
    .prepare(
      "SELECT record_json FROM durable_processes WHERE invocation_id = ?",
    )
    .get("invoke-1") as { record_json: string };
  const stored = JSON.parse(row.record_json) as {
    ownerId: string;
    mutations: Array<{ ownerId: string }>;
  };
  const forged = {
    ...stored,
    ownerId: "forged-owner",
    mutations: stored.mutations.map((mutation, index) =>
      index === 0 ? { ...mutation, ownerId: "forged-owner" } : mutation,
    ),
  };
  raw
    .prepare(
      "UPDATE durable_processes SET record_json = ? WHERE invocation_id = ?",
    )
    .run(JSON.stringify(forged), "invoke-1");
  raw.close();
  const reopened = openSqliteDurableProcessKernel(path, stateKey, {
    readOnly: true,
  });
  assert.throws(
    () => reopened.store.readByInvocation("invoke-1"),
    /corrupt|integrity/i,
  );
  reopened.store.close();
});

test("actual persisted row contains no command, argument, cwd, secret, native handle, or spill path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite");
  const kernel = openSqliteDurableProcessKernel(path, stateKey);
  writerFor(kernel).claim(prepared());
  kernel.store.close();
  const bytes = await readFile(path);
  for (const forbidden of [
    "secret-value",
    "--token",
    "C:\\host\\project",
    "nativeHandle",
    "spill.tmp",
  ])
    assert.equal(bytes.includes(Buffer.from(forbidden)), false, forbidden);
});

test("SQLite transactionally migrates legacy writable schema without trusting old rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-legacy-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE durable_processes (invocation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL)",
  );
  legacy
    .prepare("INSERT INTO durable_processes VALUES (?, ?, ?)")
    .run("legacy", 0, "{}");
  legacy.close();
  const kernel = openSqliteDurableProcessKernel(path, stateKey);
  assert.deepEqual(kernel.store.listRowIds(), ["legacy"]);
  assert.throws(
    () => kernel.store.readByInvocation("legacy"),
    /corrupt|integrity/i,
  );
  assert.equal(writerFor(kernel).claim(prepared()).won, true);
  assert.equal(kernel.store.readByInvocation("invoke-1")?.state, "prepared");
  kernel.store.close();
});

test("read-only legacy inspection neither mutates schema nor globally crashes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-legacy-ro-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(
    "CREATE TABLE durable_processes (invocation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record_json TEXT NOT NULL)",
  );
  legacy
    .prepare("INSERT INTO durable_processes VALUES (?, ?, ?)")
    .run("legacy", 0, "{}");
  legacy.close();
  const kernel = openSqliteDurableProcessKernel(path, stateKey, {
    readOnly: true,
  });
  assert.deepEqual(kernel.store.listRowIds(), ["legacy"]);
  assert.throws(
    () => kernel.store.readByInvocation("legacy"),
    /corrupt|integrity/i,
  );
  kernel.store.close();
  const inspect = new DatabaseSync(path, { readOnly: true });
  const columns = (
    inspect
      .prepare("PRAGMA table_info(durable_processes)")
      .all() as unknown as Array<{ name: string }>
  ).map(({ name }) => name);
  inspect.close();
  assert.equal(columns.includes("integrity"), false);
});
