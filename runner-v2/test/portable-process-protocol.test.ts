import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

import {
  PortableAuthorityUnavailableError,
  PortableOutputRetirementBlockedError,
  readPortableOutputSnapshot,
  resumePortableOutputRetirement,
  retirePortableOutputAcknowledgement,
  runPortableFenceEffectSync,
  runPortableFenceSnapshotSync,
  settlePortableSupervisorCommand,
} from "../src/portable-process-protocol.mjs";
import { createPortableProcessChannelProvider } from "../src/portable-process-channel.js";
import { NativeOwnedProcessBackend } from "../src/native-process-backend.js";

const supervisorSource = readFileSync(join(process.cwd(), "runner-v2", "src", "portable-process-supervisor.mjs"), "utf8");
const channelSource = readFileSync(join(process.cwd(), "runner-v2", "src", "portable-process-channel.ts"), "utf8");
const nativeBackendSource = readFileSync(join(process.cwd(), "runner-v2", "src", "native-process-backend.ts"), "utf8");

test("supervisor ACK takeover at the protected effect is a nonfatal stale no-op", () => {
  const expected = outputMetadata();
  let durableFence = { nonce: "nonce", ownerId: "owner-old", fencingToken: 3 };
  let outputDeletes = 0;
  let checkpointWrites = 0;
  let ackDeletes = 0;
  let retainedDeletes = 0;
  let lockCalls = 0;
  const reads: string[] = [];
  const context = vm.createContext({
    channelAckDirectory: "ack",
    channelDirectory: "channel",
    channelOutputDirectory: "output",
    config: { directory: "root", nonce: "nonce" },
    fencePath: join("root", "fence.json"),
    lockHolderPath: "lock-holder.json",
    outputCheckpointPath: "output-checkpoint.json",
    process: { pid: 9001 },
    retained: new Map([["stdout-000000000001", expected]]),
    retainedBytes: 4,
    PortableAuthorityUnavailableError,
    resumePortableOutputRetirement: () => undefined,
    retirePortableOutputAcknowledgement: () => { throw new Error("stale ACK retirement executed"); },
    readdirSync: () => ["stdout-000000000001.json"],
    readFileSync: (path: string) => {
      reads.push(path);
      if (path.endsWith("stdout-000000000001.json"))
        return JSON.stringify({ nonce: "nonce", ownerId: "owner-old", fencingToken: 3, metadata: expected });
      if (path.endsWith("fence.json")) return JSON.stringify(durableFence);
      if (path.endsWith("lock-holder.json")) return JSON.stringify({ nonce: "nonce", holderPid: 9001, holderBirth: "birth" });
      if (path.endsWith("output-checkpoint.json")) return JSON.stringify({ nonce: "nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } });
      throw new Error(`unexpected read ${path}`);
    },
    existsSync: () => false,
    join,
    unlinkSync: (path: string) => {
      if (path.includes("output")) outputDeletes += 1;
      else ackDeletes += 1;
    },
    writeAtomic: () => { checkpointWrites += 1; },
    runPortableFenceEffectSync: (options: { readCurrentFence: () => typeof durableFence; expectedFence: typeof durableFence; effect: () => unknown }) => {
      lockCalls += 1;
      if (lockCalls === 2) durableFence = { nonce: "nonce", ownerId: "owner-current", fencingToken: 4 };
      const current = options.readCurrentFence();
      return current.ownerId === options.expectedFence.ownerId && current.fencingToken === options.expectedFence.fencingToken
        ? { status: "applied", value: options.effect() }
        : { status: "stale" };
    },
  });
  const retained = context.retained as Map<string, unknown>;
  const originalDelete = retained.delete.bind(retained);
  retained.delete = (key: string) => { retainedDeletes += 1; return originalDelete(key); };
  vm.runInContext(`${extractFunction(supervisorSource, "readCurrentFence")}
${extractFunction(supervisorSource, "readCurrentFenceStrict")}
${extractFunction(supervisorSource, "withCurrentFenceEffect")}
${extractFunction(supervisorSource, "forgetRetiredOutput")}
${extractFunction(supervisorSource, "handleChannelAcks")}`, context);
  assert.equal(vm.runInContext('retained.has("stdout-000000000001")', context), true);
  assert.equal(vm.runInContext('JSON.stringify(JSON.parse(readFileSync(join(channelAckDirectory, "stdout-000000000001.json"), "utf8")).metadata) === JSON.stringify(retained.get("stdout-000000000001"))', context), true);

  assert.doesNotThrow(
    () => vm.runInContext("handleChannelAcks()", context),
    "a legitimate takeover must not escape the handler and kill the supervisor tick",
  );
  assert.deepEqual({ outputDeletes, checkpointWrites, ackDeletes, retainedDeletes }, {
    outputDeletes: 0,
    checkpointWrites: 0,
    ackDeletes: 0,
    retainedDeletes: 0,
  });
  assert.equal(lockCalls, 2, `the test must reach the ACK protected effect boundary; reads=${reads.join(",")}`);
});

test("supervisor ACK pass defers without a second mutation attempt when intent coordination is unavailable", () => {
  const expected = outputMetadata();
  let commits = 0;
  let retirements = 0;
  const context = vm.createContext({
    channelAckDirectory: "ack",
    channelDirectory: "channel",
    config: { nonce: "nonce" },
    retained: new Map([["stdout-000000000001", expected]]),
    readCurrentFence: () => oldFence,
    readdirSync: () => ["stdout-000000000001.json"],
    readFileSync: () => JSON.stringify({ nonce: "nonce", ...oldFence, metadata: expected }),
    join,
    writeAtomic: () => undefined,
    resumePortableOutputRetirement: () => undefined,
    retirePortableOutputAcknowledgement: () => { retirements += 1; },
    forgetRetiredOutput: () => undefined,
    withCurrentFenceEffect: (_ownerId: string, _fencingToken: number, effect: () => unknown) => {
      commits += 1;
      if (commits === 1) return { status: "unavailable", cause: "coordination", error: new Error("busy") };
      return { status: "applied", value: effect() };
    },
    PortableAuthorityUnavailableError,
  });
  vm.runInContext(`${extractFunction(supervisorSource, "handleChannelAcks")}`, context);

  assert.doesNotThrow(() => vm.runInContext("handleChannelAcks()", context));
  assert.deepEqual({ commits, retirements }, { commits: 1, retirements: 0 });
});

test("supervisor resume blocks a post-ACK intent whose filename is not bound to its metadata", () => {
  const fixture = outputFixture("mismatched-intent-name");
  const retained = new Map([["stdout-000000000001", fixture.retirement.metadata]]);
  try {
    writeFileSync(join(fixture.root, "channel", "output-checkpoint.json"), JSON.stringify({
      nonce: fixture.nonce,
      stdout: { sequence: 1, endOffset: 4 },
      stderr: { sequence: 0, endOffset: 0 },
    }));
    unlinkSync(fixture.outputPath);
    unlinkSync(fixture.ackPath);
    writeFileSync(fixture.intentPath, JSON.stringify({ ...fixture.intent, name: "stderr-000000000001.json" }));
    const context = vm.createContext({
      channelAckDirectory: join(fixture.root, "channel", "ack"),
      channelDirectory: join(fixture.root, "channel"),
      config: { nonce: fixture.nonce },
      retained,
      retainedBytes: 4,
      readCurrentFence: () => oldFence,
      withCurrentFenceEffect: (_ownerId: string, _fencingToken: number, effect: () => unknown) => ({ status: "applied", value: effect() }),
      resumePortableOutputRetirement,
      retirePortableOutputAcknowledgement: () => undefined,
      readdirSync: () => [],
      readFileSync,
      join,
      writeAtomic: () => undefined,
      PortableAuthorityUnavailableError,
    });
    vm.runInContext(`${extractFunction(supervisorSource, "forgetRetiredOutput")}
${extractFunction(supervisorSource, "handleChannelAcks")}`, context);

    assert.throws(
      () => vm.runInContext("handleChannelAcks()", context),
      (error: unknown) => error instanceof PortableOutputRetirementBlockedError,
    );
    assert.equal(retained.has("stdout-000000000001"), true);
    assert.equal(vm.runInContext("retainedBytes", context), 4);
    assert.equal(existsSync(fixture.intentPath), true);
  } finally { removeFixture(fixture.root); }
});

test("supervisor control preserves a replacement published before apply or stale retirement", () => {
  const oldRequest = { nonce: "nonce", ...oldFence, sequence: 1, action: "interrupt" };
  const replacement = { nonce: "nonce", ...currentFence, sequence: 2, action: "terminate" };
  const runSchedule = (takeover: boolean) => {
    let request: { nonce: string; ownerId: string; fencingToken: number; sequence: number; action: string } = oldRequest;
    let present = true;
    let current: { ownerId: string; fencingToken: number } = oldFence;
    let commits = 0;
    let effects = 0;
    const context = vm.createContext({
      controlPath: "control.json",
      handledControl: 0,
      existsSync: () => present,
      readFileSync: () => JSON.stringify(request),
      unlinkSync: () => { present = false; },
      readCurrentFenceStrict: () => current,
      settlePortableSupervisorCommand,
      withCurrentFenceEffect: (_ownerId: string, _fencingToken: number, effect: () => unknown) => {
        commits += 1;
        if (commits === 1) {
          request = replacement;
          current = currentFence;
          if (takeover) return { status: "stale" };
        }
        return { status: "applied", value: effect() };
      },
    });
    vm.runInContext(`${extractFunction(supervisorSource, "completeControl")}`, context);
    (context.completeControl as (request: typeof oldRequest, apply: () => void) => unknown)(oldRequest, () => { effects += 1; });
    return { context, request, present, commits, effects };
  };

  const takeover = runSchedule(true);
  assert.equal(takeover.present, true, "stale retirement must preserve the current owner's replacement");
  assert.deepEqual(takeover.request, replacement);
  assert.equal(takeover.effects, 0);
  assert.equal(vm.runInContext("handledControl", takeover.context), 0);

  const applied = runSchedule(false);
  assert.equal(applied.present, true);
  assert.deepEqual(applied.request, replacement);
  assert.equal(applied.effects, 0, "an old request must not execute after same-fence replacement");
  assert.equal(vm.runInContext("handledControl", applied.context), 0);
});

test("supervisor control rejects fractional and future-gap sequences before the effect boundary", () => {
  for (const sequence of [1.5, 3]) {
    let commits = 0;
    const request = { nonce: "nonce", ...oldFence, sequence, action: "interrupt" };
    const context = vm.createContext({
      config: { nonce: "nonce", platform: "windows" },
      controlPath: "control.json",
      handledControl: 0,
      targetExited: true,
      existsSync: () => true,
      readFileSync: () => JSON.stringify(request),
      unlinkSync: () => undefined,
      readCurrentFenceStrict: () => oldFence,
      settlePortableSupervisorCommand,
      withCurrentFenceEffect: (_ownerId: string, _fencingToken: number, effect: () => unknown) => {
        commits += 1;
        return { status: "applied", value: effect() };
      },
    });
    vm.runInContext(`${extractFunction(supervisorSource, "completeControl")}
${extractFunction(supervisorSource, "handleControl")}`, context);

    assert.throws(() => vm.runInContext("handleControl()", context), /control command identity is invalid/);
    assert.equal(commits, 0, String(sequence));
    assert.equal(vm.runInContext("handledControl", context), 0, String(sequence));
  }
});

test("channel snapshot does not classify an ACK retirement between filename list and checkpoint read as corruption", () => {
  const metadata = outputMetadata();
  const bytes = Buffer.from("data");
  const context = vm.createContext({
    Buffer,
    Error,
    Map,
    Uint8Array,
    createHash,
    join,
    readdirSync: () => ["stdout-000000000001.json"],
    readFileSync: () => JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }),
    validMetadata: (value: typeof metadata, actual: Uint8Array) =>
      value.digest === createHash("sha256").update(actual).digest("hex"),
  });
  vm.runInContext(compiledClassMethod(channelSource, "outputFiles"), context);
  const checkpoint = {
    stdout: { sequence: 1, endOffset: 4 },
    stderr: { sequence: 0, endOffset: 0 },
  };
  const channel = {
    authority: {
      nonce: "nonce",
      supervisorPid: 9001,
      snapshot: () => ({ status: "applied", value: { checkpoint, output: [], acknowledgements: [] } }),
    },
    outputDirectory: "output",
    deliveredOutput: new Set<string>(),
    outputCheckpoint: () => checkpoint,
    readOutputSnapshot: () => { throw new Error("torn filename/checkpoint schedule was observed"); },
    outputSnapshot() { return this.authority.snapshot(); },
    requireSnapshot(snapshot: { status: string; value: unknown }) {
      if (snapshot.status !== "applied") throw new Error("snapshot unavailable");
      return snapshot.value;
    },
  };

  assert.doesNotThrow(
    () => (context.outputFiles as (this: typeof channel) => unknown).call(channel),
    "a valid concurrent filename/checkpoint transition must be retried or serialized",
  );
});

test("native output settlement rejects unexplained missing output without an authenticated retirement intent", () => {
  const context = vm.createContext({
    JSON,
    Error,
    Number,
    join,
    existsSync: () => false,
    readFileSync: (path: string) => {
      if (path.endsWith("output-checkpoint.json")) return JSON.stringify({
        nonce: "nonce",
        stdout: { sequence: 0, endOffset: 0 },
        stderr: { sequence: 0, endOffset: 0 },
      });
      throw new Error(`unexpected read ${path}`);
    },
    readdirSync: () => [],
    statSync: (path: string) => ({ size: path.endsWith("stdout.log") ? 4 : 0 }),
    validatePortableAcknowledgementEvidence: () => [],
    PortableOutputRetirementBlockedError,
  });
  vm.runInContext(compiledFunction(nativeBackendSource, "assertPortableOutputSettled"), context);

  assert.throws(
    () => vm.runInContext('assertPortableOutputSettled({ directory: "root", nonce: "nonce" })', context),
    (error: unknown) => error instanceof PortableOutputRetirementBlockedError,
  );
});

test("native output settlement retains a completed retirement intent until the protocol finalizes it", () => {
  const context = vm.createContext({
    JSON,
    Error,
    Number,
    join,
    existsSync: (path: string) => path.endsWith("output-retirement.json"),
    readFileSync: (path: string) => {
      if (path.endsWith("output-checkpoint.json")) return JSON.stringify({
        nonce: "nonce",
        stdout: { sequence: 1, endOffset: 4 },
        stderr: { sequence: 0, endOffset: 0 },
      });
      throw new Error(`unexpected read ${path}`);
    },
    readdirSync: () => [],
    statSync: (path: string) => ({ size: path.endsWith("stdout.log") ? 4 : 0 }),
    validatePortableAcknowledgementEvidence: () => [],
    PortableOutputRetirementBlockedError,
  });
  vm.runInContext(compiledFunction(nativeBackendSource, "assertPortableOutputSettled"), context);

  assert.throws(
    () => vm.runInContext('assertPortableOutputSettled({ directory: "root", nonce: "nonce" })', context),
    (error: unknown) => error instanceof PortableOutputRetirementBlockedError,
  );
});

const oldFence = { ownerId: "owner-old", fencingToken: 3 } as const;
const currentFence = { ownerId: "owner-current", fencingToken: 4 } as const;

test("portable supervisor stale command retirement advances sequence without executing or acknowledging the command", () => {
  const fixture = protocolFixture("takeover-command");
  let effects = 0;
  let acknowledgements = 0;
  let progress = 0;
  try {
    writeFence(fixture, currentFence);
    const result = settlePortableSupervisorCommand({
      expectedFence: oldFence,
      readCurrentFence: () => readFence(fixture),
      commit: (fence, effect) => runPortableFenceEffectSync({
        lockPath: fixture.lockPath,
        expectedFence: fence,
        readCurrentFence: () => readFence(fixture),
        effect,
      }),
      apply: () => { effects += 1; acknowledgements += 1; progress += 1; },
      retireStale: () => { progress += 1; },
    });

    assert.deepEqual(result, { status: "stale", retirement: "applied" });
    assert.equal(effects, 0);
    assert.equal(acknowledgements, 0);
    assert.equal(progress, 1);
  } finally { removeFixture(fixture.root); }
});

test("portable supervisor command defers coordination unavailability without effects, acknowledgement, or progress", () => {
  let effects = 0;
  let progress = 0;
  const result = settlePortableSupervisorCommand({
    expectedFence: oldFence,
    readCurrentFence: () => oldFence,
    commit: () => ({ status: "unavailable", cause: "coordination", error: new Error("busy") }),
    apply: () => { effects += 1; progress += 1; },
    retireStale: () => { progress += 1; },
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.cause, "coordination");
  assert.equal(effects, 0);
  assert.equal(progress, 0);
});

test("portable fence effect distinguishes missing authority from an indeterminate started effect", () => {
  const fixture = protocolFixture("effect-outcomes");
  try {
    const authority = runPortableFenceEffectSync({
      lockPath: fixture.lockPath,
      expectedFence: oldFence,
      readCurrentFence: () => { throw new PortableAuthorityUnavailableError("missing fence"); },
      effect: () => "unreachable",
    });
    assert.equal(authority.status, "unavailable");
    assert.equal(authority.cause, "authority");

    const indeterminate = runPortableFenceEffectSync({
      lockPath: fixture.lockPath,
      expectedFence: oldFence,
      readCurrentFence: () => oldFence,
      effect: () => { throw new Error("effect interrupted"); },
    });
    assert.equal(indeterminate.status, "outcome_unknown");
  } finally { removeFixture(fixture.root); }
});

test("portable read snapshot reports corrupt evidence as blocked rather than an indeterminate effect", () => {
  const fixture = protocolFixture("snapshot-outcomes");
  try {
    const result = runPortableFenceSnapshotSync({
      lockPath: fixture.lockPath,
      expectedFence: oldFence,
      readCurrentFence: () => oldFence,
      read: () => { throw new PortableOutputRetirementBlockedError("corrupt checkpoint"); },
    });
    assert.equal(result.status, "blocked");
  } finally { removeFixture(fixture.root); }
});

test("portable ACK retirement resumes every durable boundary exactly once", () => {
  for (const boundary of ["intent", "output", "checkpoint", "ack"] as const) {
    const fixture = outputFixture(`resume-${boundary}`);
    let interrupted = false;
    try {
      assert.throws(() => retirePortableOutputAcknowledgement({
        ...fixture.retirement,
        afterBoundary: (actual) => {
          if (!interrupted && actual === boundary) {
            interrupted = true;
            throw new Error(`interrupt after ${boundary}`);
          }
        },
      }), /interrupt/);

      retirePortableOutputAcknowledgement(fixture.retirement);
      assert.equal(existsSync(fixture.outputPath), false, boundary);
      assert.equal(existsSync(fixture.ackPath), false, boundary);
      assert.equal(existsSync(fixture.intentPath), false, boundary);
      assert.deepEqual(readCheckpoint(fixture.root).stdout, { sequence: 1, endOffset: 4 }, boundary);
    } finally { removeFixture(fixture.root); }
  }
});

test("a higher-fence owner resumes exact former-owner ACK intent without replaying or losing bytes", () => {
  const fixture = outputFixture("retirement-takeover");
  try {
    assert.throws(() => retirePortableOutputAcknowledgement({
      ...fixture.retirement,
      afterBoundary: (boundary) => {
        if (boundary === "output") throw new Error("interrupt after output");
      },
    }), /interrupt after output/);
    resumePortableOutputRetirement({
      channelDirectory: join(fixture.root, "channel"),
      nonce: fixture.nonce,
      fence: currentFence,
    });
    assert.equal(existsSync(fixture.outputPath), false);
    assert.equal(existsSync(fixture.ackPath), false);
    assert.equal(existsSync(fixture.intentPath), false);
    assert.deepEqual(readCheckpoint(fixture.root).stdout, { sequence: 1, endOffset: 4 });
  } finally { removeFixture(fixture.root); }
});

test("portable ACK resume rejects same-token foreign and future intent provenance before mutation", () => {
  for (const operation of ["resume", "existing-retire"] as const) for (const fault of ["same-token-foreign", "future"] as const) {
    const fixture = outputFixture(`intent-provenance-${operation}-${fault}`);
    try {
      writeFileSync(join(fixture.root, "channel", "output-checkpoint.json"), JSON.stringify({
        nonce: fixture.nonce,
        stdout: { sequence: 1, endOffset: 4 },
        stderr: { sequence: 0, endOffset: 0 },
      }));
      unlinkSync(fixture.outputPath);
      unlinkSync(fixture.ackPath);
      writeFileSync(fixture.intentPath, JSON.stringify({
        ...fixture.intent,
        ownerId: fault === "same-token-foreign" ? "owner-foreign" : "owner-future",
        fencingToken: fault === "same-token-foreign" ? currentFence.fencingToken : currentFence.fencingToken + 1,
      }));

      assert.throws(
        () => operation === "resume"
          ? resumePortableOutputRetirement({
              channelDirectory: join(fixture.root, "channel"),
              nonce: fixture.nonce,
              fence: currentFence,
            })
          : retirePortableOutputAcknowledgement({ ...fixture.retirement, fence: currentFence }),
        (error: unknown) => error instanceof PortableOutputRetirementBlockedError,
        `${operation}-${fault}`,
      );
      assert.equal(existsSync(fixture.intentPath), true, `${operation}-${fault}`);
      assert.deepEqual(readCheckpoint(fixture.root).stdout, { sequence: 1, endOffset: 4 }, `${operation}-${fault}`);
    } finally { removeFixture(fixture.root); }
  }
});

test("portable ACK retirement blocks foreign, corrupt, and unexplained partial evidence", () => {
  for (const fault of ["foreign", "corrupt", "missing_intent"] as const) {
    const fixture = outputFixture(`blocked-${fault}`);
    try {
      if (fault === "foreign") writeFileSync(fixture.intentPath, JSON.stringify({ ...fixture.intent, nonce: "foreign-nonce" }));
      else if (fault === "corrupt") writeFileSync(fixture.intentPath, "{not-json");
      else unlinkSync(fixture.outputPath);
      assert.throws(
        () => retirePortableOutputAcknowledgement(fixture.retirement),
        (error: unknown) => error instanceof PortableOutputRetirementBlockedError,
        fault,
      );
      assert.equal(existsSync(fixture.ackPath), true, fault);
    } finally { removeFixture(fixture.root); }
  }
});

test("portable snapshot validates one coherent checkpoint, retained suffix, and ACK state", () => {
  const fixture = outputFixture("coherent-snapshot");
  try {
    const before = readPortableOutputSnapshot({ channelDirectory: join(fixture.root, "channel"), nonce: fixture.nonce, supervisorPid: 9001 });
    assert.deepEqual(before.output.map((entry) => entry.metadata.sequence), [1]);
    assert.deepEqual(before.acknowledgements, ["stdout-000000000001.json"]);
    retirePortableOutputAcknowledgement(fixture.retirement);
    const after = readPortableOutputSnapshot({ channelDirectory: join(fixture.root, "channel"), nonce: fixture.nonce, supervisorPid: 9001 });
    assert.deepEqual(after.output, []);
    assert.deepEqual(after.acknowledgements, []);
    assert.deepEqual(after.checkpoint.stdout, { sequence: 1, endOffset: 4 });
  } finally { removeFixture(fixture.root); }
});

test("portable snapshot and ACK retirement share the real owned lock and never expose a torn state", () => {
  const fixture = outputFixture("real-lock-snapshot-retirement");
  const snapshot = (deadlineMs = 2_000) => runPortableFenceSnapshotSync({
    lockPath: fixture.lockPath,
    expectedFence: oldFence,
    readCurrentFence: () => readFence(fixture),
    read: () => readPortableOutputSnapshot({
      channelDirectory: join(fixture.root, "channel"),
      nonce: fixture.nonce,
      supervisorPid: 9001,
    }),
    lockOptions: { deadlineMs, retryDelayMs: 1 },
  });
  try {
    const before = snapshot();
    assert.equal(before.status, "applied");
    if (before.status === "applied") {
      assert.deepEqual(before.value.output.map((entry) => entry.metadata.sequence), [1]);
      assert.deepEqual(before.value.checkpoint.stdout, { sequence: 0, endOffset: 0 });
    }
    let during: ReturnType<typeof snapshot> | undefined;
    const retirement = runPortableFenceEffectSync({
      lockPath: fixture.lockPath,
      expectedFence: oldFence,
      readCurrentFence: () => readFence(fixture),
      effect: () => retirePortableOutputAcknowledgement({
        ...fixture.retirement,
        afterBoundary: (boundary) => {
          if (boundary === "output") during = snapshot(25);
        },
      }),
    });
    assert.equal(retirement.status, "applied");
    assert.equal(during?.status, "unavailable", "a reader cannot enter between output deletion and checkpoint publication");
    if (during?.status === "unavailable") assert.equal(during.cause, "coordination");

    const after = snapshot();
    assert.equal(after.status, "applied");
    if (after.status === "applied") {
      assert.deepEqual(after.value.output, []);
      assert.deepEqual(after.value.acknowledgements, []);
      assert.deepEqual(after.value.checkpoint.stdout, { sequence: 1, endOffset: 4 });
    }
  } finally { removeFixture(fixture.root); }
});

test("portable attach validates inside its existing effect lock and snapshots only after that effect releases", async () => {
  const fixture = outputFixture("attach-lock-composition");
  let inEffect = false;
  let inSnapshot = false;
  let snapshots = 0;
  try {
    writeFileSync(join(fixture.root, "channel", "client-state.json"), JSON.stringify({
      nonce: fixture.nonce,
      ...oldFence,
      nextCommand: 1,
      nextWrite: 1,
      inputClosed: false,
    }));
    const provider = createPortableProcessChannelProvider({
      replayCapacityChunks: 1,
      replayCapacityBytes: 8,
      pollIntervalMs: 5,
      authority: () => ({
        directory: fixture.root,
        nonce: fixture.nonce,
        fence: oldFence,
        supervisorPid: 9001,
        reattest: () => "live",
        effect: async (_kind, effect) => {
          inEffect = true;
          try { return effect(); }
          finally { inEffect = false; }
        },
        snapshot: (read) => {
          assert.equal(inEffect, false, "snapshot must not recursively acquire the attach effect lock");
          snapshots += 1;
          inSnapshot = true;
          try { return { status: "applied", value: read() }; }
          finally { inSnapshot = false; }
        },
      }),
    });
    const channel = await provider.acquire(syntheticBinding(fixture.root, fixture.nonce), oldFence);
    assert.deepEqual(channel.retainedWindow().map((entry) => entry.sequence), [1]);
    const delivered = new Promise<void>((resolve) => {
      const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata) => {
        assert.equal(inSnapshot, false, "the output snapshot lock must release before invoking the consumer");
        unsubscribe();
        resolve();
        return metadata;
      });
    });
    await delivered;
    assert.equal(snapshots, 2);
    await channel.detach();
  } finally { removeFixture(fixture.root); }
});

test("native empty verification performs final output validation inside its existing fence effect without recursive locking", async () => {
  const fixture = settledNativeFixture("native-lock-composition");
  const backend = new NativeOwnedProcessBackend({
    stateDirectory: fixture.root,
    platform: "windows",
    backendId: "runner-windows-supervisor-v1",
    capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "unavailable" },
    operations: {
      inspectProcessBirth: () => ({ state: "absent" }),
      inspectProcessBirths: (pids) => new Map(pids.map((pid) => [pid, { state: "absent" as const }])),
      listPosixGroup: () => undefined,
      signal: () => undefined,
    },
  });
  try {
    const result = await backend.verifyEmpty(fixture.binding, oldFence) as { empty: boolean };
    assert.equal(result.empty, true);
  } finally { removeFixture(fixture.root); }
});

function outputMetadata() {
  const bytes = Buffer.from("data");
  return {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: 4,
    byteLength: 4,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function extractFunction(source: string, name: string): string {
  const file = ts.createSourceFile("source.mjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`missing function ${name}`);
  return declaration.getText(file);
}

function compiledFunction(source: string, name: string): string {
  return ts.transpileModule(`${extractFunction(source, name)}\nglobalThis.${name} = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function compiledClassMethod(source: string, name: string): string {
  const marker = `private ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing method ${name}`);
  const statementCandidates = [source.indexOf("\n    let names:", start), source.indexOf("\n    return ", start)].filter((index) => index >= 0);
  const firstStatement = Math.min(...statementCandidates);
  if (firstStatement < 0) throw new Error(`missing method body ${name}`);
  const bodyStart = source.lastIndexOf("{", firstStatement);
  const method = source.slice(start, matchingBraceEnd(source, bodyStart));
  return ts.transpileModule(`class Probe { ${method} }\nglobalThis.${name} = Probe.prototype.${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function matchingBraceEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  throw new Error("unterminated function");
}

function protocolFixture(label: string) {
  const root = join(tmpdir(), `aiboard-c1-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: false });
  const fencePath = join(root, "fence.json");
  const lockPath = join(root, ".fence.lock");
  writeFence({ fencePath }, oldFence);
  return { root, fencePath, lockPath };
}

function outputFixture(label: string) {
  const fixture = protocolFixture(label);
  const nonce = `nonce-${label}`;
  const channelDirectory = join(fixture.root, "channel");
  const outputDirectory = join(channelDirectory, "output");
  const acknowledgementDirectory = join(channelDirectory, "ack");
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(acknowledgementDirectory, { recursive: true });
  const bytes = Buffer.from("data");
  const metadata = {
    stream: "stdout" as const,
    sequence: 1,
    startOffset: 0,
    endOffset: 4,
    byteLength: 4,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  const name = "stdout-000000000001.json";
  const outputPath = join(outputDirectory, name);
  const ackPath = join(acknowledgementDirectory, name);
  const intentPath = join(channelDirectory, "output-retirement.json");
  writeFileSync(join(channelDirectory, "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(outputPath, JSON.stringify({ nonce, metadata, bytes: bytes.toString("base64") }));
  writeFileSync(ackPath, JSON.stringify({ nonce, ...oldFence, metadata }));
  const intent = {
    protocol: "aiboard-portable-output-retirement/v1",
    nonce,
    ownerId: oldFence.ownerId,
    fencingToken: oldFence.fencingToken,
    name,
    metadata,
    before: { sequence: 0, endOffset: 0 },
    after: { sequence: 1, endOffset: 4 },
  };
  return {
    ...fixture,
    nonce,
    outputPath,
    ackPath,
    intentPath,
    intent,
    retirement: { channelDirectory, nonce, fence: oldFence, name, metadata },
  };
}

function writeFence(fixture: { fencePath: string }, value: { ownerId: string; fencingToken: number }): void {
  writeFileSync(fixture.fencePath, JSON.stringify({ nonce: "protocol-nonce", ...value }));
}
function readFence(fixture: { fencePath: string }): { ownerId: string; fencingToken: number } {
  const value = JSON.parse(readFileSync(fixture.fencePath, "utf8"));
  if (value.nonce !== "protocol-nonce") throw new PortableAuthorityUnavailableError("foreign fence");
  return { ownerId: value.ownerId, fencingToken: value.fencingToken };
}
function readCheckpoint(root: string): { stdout: { sequence: number; endOffset: number } } {
  return JSON.parse(readFileSync(join(root, "channel", "output-checkpoint.json"), "utf8"));
}
function removeFixture(root: string): void {
  assert.match(root, /^.+aiboard-c1-/);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

function syntheticBinding(directory: string, nonce: string) {
  return {
    registryId: "registry",
    backendId: "runner-windows-supervisor-v1",
    implementationGeneration: "generation",
    implementationDigest: "1".repeat(64),
    attestationVersion: 1,
    attestationDigest: "2".repeat(64),
    opaqueIdentity: Buffer.from(JSON.stringify({ directory, nonce })).toString("base64url"),
    birthFingerprint: { observedAt: "now", discriminator: "birth" },
    rootPid: 9001,
    startedAt: "now",
  };
}

function settledNativeFixture(label: string) {
  const base = protocolFixture(label);
  const directory = join(base.root, "owned-synthetic");
  const nonce = `native-${label}`;
  const supervisorPid = 9001;
  const supervisorBirth = "synthetic-birth";
  mkdirSync(join(directory, "channel", "output"), { recursive: true });
  mkdirSync(join(directory, "channel", "input"), { recursive: true });
  mkdirSync(join(directory, "channel", "ack"), { recursive: true });
  writeFileSync(join(directory, "fence.json"), JSON.stringify({ nonce, ...oldFence }));
  writeFileSync(join(directory, "stdout.log"), "");
  writeFileSync(join(directory, "stderr.log"), "");
  writeFileSync(join(directory, "channel", "output-checkpoint.json"), JSON.stringify({
    nonce,
    stdout: { sequence: 0, endOffset: 0 },
    stderr: { sequence: 0, endOffset: 0 },
  }));
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1",
    nonce,
    supervisorPid,
    launchEffect: "started",
    rootProcess: { pid: supervisorPid, birth: supervisorBirth },
    revision: 1,
    handledControl: 0,
    status: "stopped",
    exitCode: 0,
    signal: null,
    knownProcesses: [{ pid: supervisorPid, birth: supervisorBirth }],
    error: null,
    updatedAt: "2026-09-05T00:00:00.000Z",
  }));
  const identity = { version: 1, backendId: "runner-windows-supervisor-v1", nonce, directory, supervisorPid, supervisorBirth, fence: oldFence };
  return {
    root: base.root,
    binding: {
      ...syntheticBinding(directory, nonce),
      opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"),
      birthFingerprint: {
        observedAt: "2026-09-05T00:00:00.000Z",
        discriminator: createHash("sha256").update(`${nonce}\0${supervisorBirth}`).digest("hex"),
      },
    },
  };
}
