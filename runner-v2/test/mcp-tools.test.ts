import { McpProtocolError } from "../src/mcp-rpc-peer.js";
import { canonicalMcpDigest, mcpConfigurationDigest, fixedMcpEnvelope, type McpServerSpec } from "../src/mcp-configuration.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { McpDiscoveryResult, McpDiscoveryTool } from "../src/runner-internal-execution-context.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";
import {
  cleanupRecoveredMcpTransports,
  createExecutionHostMcpTransportFactory,
} from "../src/execution-host-mcp-transport.js";
import {
  McpManager,
  createLiveMcpStatusRegistry,
  createMcpTools,
  type McpServerStatus,
  type McpTransportFactory,
} from "../src/mcp-tools.js";
import {
  emptyRunnerCapabilitiesConfig,
  type RunnerCapabilitiesConfig,
} from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";
import { openSqliteStreamingSessionStore } from "../src/streaming-session-store.js";
import { withOwnedFenceLockSync } from "../src/owned-fence-lock.mjs";
import { runnerRunStateSegment } from "../src/run-state-identity.js";

function strictMcpProviderIds() {
  // Keep every UUID bit, with lowercase hex also distinct on case-insensitive filesystems.
  return ["portable", "unavailable", "absolute"].map((kind) => `s${kind[0]}-${randomUUID().replaceAll("-", "")}`);
}

test("C5 round5 strict OCI fixture identities support real SQLite lease locks across distinct fixtures", async (t) => {
  const identities = [strictMcpProviderIds(), strictMcpProviderIds()];
  assert.equal(new Set(identities.flat()).size, 6);
  for (const [fixture, providers] of identities.entries()) {
    for (const [index, kind] of ["portable", "unavailable", "absolute"].entries()) {
      await t.test(`${kind} fixture ${fixture + 1}`, () => {
        // Match the actual strict owner's temporary state-root length and run layout.
        const prefix = "aiboard-c5-path-probe-".padEnd("aiboard-mcp-strict-state-".length, "-");
        const root = mkdtempSync(join(tmpdir(), prefix));
        console.log(JSON.stringify({ created: root, fixture, kind }));
        try {
          const provider = providers[index]!;
          const statePath = join(root, "builds", runnerRunStateSegment(provider),
            "execution-isolation", provider, `oci-leases-${provider}.json`);
          const lockPath = `${statePath}.lock`;
          let effects = 0;
          let inspections = 0;
          let lockError: unknown;
          mkdirSync(dirname(lockPath), { recursive: true });
          try {
            withOwnedFenceLockSync(lockPath, () => {
              effects++;
              writeFileSync(statePath, "[]");
            }, {
              holderPid: 4242,
              holderBirth: "synthetic-exact-holder-birth",
              inspectHolder: () => {
                inspections++;
                return "same";
              },
              deadlineMs: 500, retryDelayMs: 5, retireAfterEffect: false,
            });
          } catch (error) { lockError = error; }
          const lock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
          console.log(JSON.stringify({ fixture, kind, provider, lockPath, lockLength: lockPath.length,
            journalLength: `${lockPath}-journal`.length, effects, inspections, lockBytes: lock?.length,
            leaseStateExists: existsSync(statePath), lockError: lockError instanceof Error ? {
              name: lockError.name, message: lockError.message, cause: lockError.cause,
            } : lockError }));
          assert.equal(lockError, undefined);
          assert.equal(effects, 1);
          assert.equal(inspections, 0);
          assert.equal(readFileSync(statePath, "utf8"), "[]");
          assert.equal(lock?.subarray(0, 16).toString(), "SQLite format 3\0");
          // Budget the longest SQLite sidecar, including on platforms without MAX_PATH.
          assert.ok(`${lockPath}-journal`.length < 260, "strict fixture SQLite journal path must fit MAX_PATH");
        } finally {
          const absolute = resolve(root);
          assert.equal(dirname(absolute), resolve(tmpdir()));
          assert.equal(absolute, root);
          assert.ok(absolute.slice(dirname(absolute).length + 1).startsWith(prefix));
          rmSync(absolute, { recursive: true, force: true });
          const absent = !existsSync(absolute);
          console.log(JSON.stringify({ removed: root, absent }));
          assert.equal(absent, true);
        }
      });
    }
  }
});

test("C5 round4 finalizer retains state when a later pending observation fails", async () => {
  const roots = syntheticMcpRoots();
  const pendingFailure = new Error("synthetic pending observation failed");
  try {
    await assert.rejects(finishOwnedMcpFixture({ root: roots.root, hasPrimaryFailure: false, primaryFailure: undefined,
      owner: { stateDirectory: roots.stateDirectory, async close(options) {
        if (!options?.retainStateDirectory) rmSync(roots.stateDirectory, { recursive: true, force: true });
      } },
      async settlePendingCall() { throw pendingFailure; },
    }), (error: unknown) => error instanceof AggregateError && error.errors.includes(pendingFailure));
    assert.equal(existsSync(roots.root), true);
    assert.equal(existsSync(roots.stateDirectory), true);
  } finally { roots.dispose(); }
});

function syntheticMcpRoots() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-round4-project-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "aiboard-c5-round4-state-"));
  console.log(JSON.stringify({ created: [root, stateDirectory] }));
  return { root, stateDirectory, dispose() {
    for (const path of [root, stateDirectory]) rmSync(path, { recursive: true, force: true });
    console.log(JSON.stringify({ removed: [root, stateDirectory], absent: [!existsSync(root), !existsSync(stateDirectory)] }));
  } };
}

for (const count of [0, 1, 2, 3, 4]) {
  test(`C5 round4 construction failure after ${count} owners closes every known owner and retains roots`, async () => {
    const roots = syntheticMcpRoots();
    const kinds = ["host", "internal", "run", "manager"] as const;
    const closed: string[] = [];
    const closeFailures = kinds.map((kind) => new Error(`synthetic ${kind} close`));
    try {
      const failure = await constructOwnedMcpFixture(roots.stateDirectory, async (own) => {
        for (let index = 0; index < count; index++) own(kinds[index]!, { async close() {
          closed.push(kinds[index]!); throw closeFailures[index];
        } });
        throw 0; // A falsy construction failure must never become success.
      }).then(() => undefined, (error: unknown) => error);
      assert.ok(failure instanceof AggregateError);
      assert.deepEqual(closed, kinds.slice(0, count).reverse());
      assert.deepEqual(failure.errors, [0, ...closeFailures.slice(0, count).reverse()]);
      assert.equal(existsSync(roots.root), true);
      assert.equal(existsSync(roots.stateDirectory), true);
    } finally { roots.dispose(); }
  });
}

test("C5 round4 finalizer aggregates falsy primary every owner close and all release absence residue proofs", async () => {
  const roots = syntheticMcpRoots();
  const events: string[] = [];
  const failures = [new Error("close one"), new Error("close two"), new Error("release"), new Error("absence"), new Error("residue")];
  try {
    const failure = await finishOwnedMcpFixture({ root: roots.root, stateDirectories: [roots.stateDirectory],
      hasPrimaryFailure: true, primaryFailure: 0,
      owners: [0, 1].map((index) => ({ stateDirectory: roots.stateDirectory, async close(options) {
        assert.equal(options?.retainStateDirectory, true); events.push(`close ${index}`); throw failures[index];
      } })),
      verify: [2, 3, 4].map((index) => async () => { events.push(failures[index]!.message); throw failures[index]; }),
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [0, ...failures]);
    assert.deepEqual(events, ["close 0", "close 1", "release", "absence", "residue"]);
    assert.equal(existsSync(roots.root), true);
    assert.equal(existsSync(roots.stateDirectory), true);
  } finally { roots.dispose(); }
});

for (const proof of ["release", "absence", "residue"] as const) {
  test(`C5 round4 failed ${proof} alone prevents disposal after successful owner close`, async () => {
    const roots = syntheticMcpRoots();
    const failure = new Error(`synthetic ${proof}`);
    try {
      const owner = await constructOwnedMcpFixture(roots.stateDirectory, async (own) => {
        own("host", { async close() {} }); return {};
      });
      const serverMarker = join(roots.root, "server.pid");
      const descendantMarker = join(roots.root, "descendant.pid");
      writeFileSync(serverMarker, "900001"); writeFileSync(descendantMarker, "900002");
      await assert.rejects(finishOwnedMcpFixture({ root: roots.root, owner, hasPrimaryFailure: false, primaryFailure: undefined,
        verify: [async () => {
          if (proof === "absence") await verifyMcpTreeAbsent(serverMarker, descendantMarker, 5_000, () => { throw failure; });
          else if (proof === "residue") dockerOwnedContainers("synthetic-docker", "synthetic-fixture", () => { throw failure; });
          else throw failure;
        }],
      }), (error: unknown) => error instanceof AggregateError && error.errors.includes(failure));
      assert.equal(existsSync(roots.root), true);
      assert.equal(existsSync(roots.stateDirectory), true);
    } finally { roots.dispose(); }
  });
}

test("C5 round4 finalizer refuses disposal with missing owner and captured construction state", async () => {
  const roots = syntheticMcpRoots();
  try {
    await assert.rejects(finishOwnedMcpFixture({ root: roots.root, stateDirectories: [roots.stateDirectory],
      primaryFailure: undefined, hasPrimaryFailure: false,
    }), (error: unknown) => error instanceof AggregateError && /owner is unavailable/.test(String(error.errors[0])));
    assert.equal(existsSync(roots.root), true);
    assert.equal(existsSync(roots.stateDirectory), true);
  } finally { roots.dispose(); }
});

test("C5 round4 OCI residue observation uses only the exact fixture identity and read-only argv", () => {
  const providers = [randomUUID(), randomUUID()];
  assert.notEqual(providers[0], providers[1]);
  const commands: string[][] = [];
  for (const provider of providers) assert.equal(dockerOwnedContainers("synthetic-docker", provider,
    (_docker, args) => { commands.push([...args]); return " exact-current-id\n"; }), "exact-current-id");
  assert.deepEqual(commands, providers.map((provider) => ["ps", "--all", "--quiet", "--filter",
    "label=ai-board.runner-v2.owned=true", "--filter", `label=ai-board.runner-v2.provider=${provider}`]));
});

test("C5 round4 actual empty owner release proof reopens retained durable state after all owners close", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-round4-empty-owner-"));
  const stateDirectories: string[] = [];
  let owner: Awaited<ReturnType<typeof ownedManager>> | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    owner = await ownedManager(root, [], undefined, (stateDirectory) => {
      stateDirectories.push(stateDirectory); console.log(JSON.stringify({ created: [root, stateDirectory] }));
    });
    await owner.close({ retainStateDirectory: true });
    assert.deepEqual(owner.mcpSessionStates(), []);
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finishOwnedMcpFixture({ root, owner, stateDirectories, primaryFailure, hasPrimaryFailure,
      verify: [async () => { assert.ok(owner); assert.deepEqual(owner.mcpSessionStates(), []); }],
    });
    console.log(JSON.stringify({ removed: [root, ...stateDirectories], absent: [root, ...stateDirectories].map((path) => !existsSync(path)) }));
  }
});

test("C5 round4 constructed fixture retries one exact transient owner close before declaring cleanup failure", async () => {
  const roots = syntheticMcpRoots();
  let attempts = 0;
  try {
    const owner = await constructOwnedMcpFixture(roots.stateDirectory, async (own) => {
      own("run", { async close() { attempts += 1; if (attempts === 1) throw new Error("retryable synthetic cleanup"); } });
      return {};
    });
    await owner.close({ retainStateDirectory: true });
    assert.equal(attempts, 2);
    assert.equal(existsSync(roots.stateDirectory), true);
  } finally { roots.dispose(); }
});

test("C5 round4 successful disposal follows retained idempotent close pending settlement and every proof", async () => {
  const roots = syntheticMcpRoots();
  const events: string[] = [];
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => { settle = resolve; });
  try {
    const owner = await constructOwnedMcpFixture(roots.stateDirectory, async (own) => {
      for (const kind of ["host", "internal", "run", "manager"] as const) own(kind, { async close() { events.push(kind); } });
      return {};
    });
    await owner.close({ retainStateDirectory: true });
    assert.equal(existsSync(roots.stateDirectory), true);
    const finalizing = observeMcpCall(finishOwnedMcpFixture({ root: roots.root, owner,
      hasPrimaryFailure: false, primaryFailure: undefined,
      async settlePendingCall() { await pending; events.push("pending"); },
      verify: [async () => { events.push("proof"); assert.equal(existsSync(roots.root), true); assert.equal(existsSync(roots.stateDirectory), true); }],
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["manager", "run", "internal", "host"]);
    assert.equal(existsSync(roots.root), true);
    assert.equal(existsSync(roots.stateDirectory), true);
    settle();
    assert.deepEqual(await finalizing, { status: "fulfilled", value: undefined });
    assert.deepEqual(events, ["manager", "run", "internal", "host", "pending", "proof"]);
    assert.equal(existsSync(roots.root), false);
    assert.equal(existsSync(roots.stateDirectory), false);
  } finally { settle(); roots.dispose(); }
});

for (const mode of ["running", "exited", "stop-error", "stop-refused", "join-error", "both-errors"] as const) {
  test(`C5 round4 directly owned wrapper ${mode} is stopped only by handle and joined before finalization`, async () => {
    const roots = syntheticMcpRoots();
    const child = new EventEmitter();
    const closed = observeOwnedMcpWrapper(child);
    const stopFailure = new Error("synthetic direct stop error");
    const joinFailure = new Error("synthetic wrapper error before close");
    const events: string[] = [];
    let finished = false;
    const joining = observeMcpCall(stopAndJoinOwnedMcpWrapper({ exitCode: mode === "exited" ? 86 : null, signalCode: null,
      kill(signal) {
        events.push(`stop ${signal}`);
        if (mode === "stop-error" || mode === "both-errors") throw stopFailure;
        return mode !== "stop-refused";
      },
    }, closed)).then((outcome) => { finished = true; return outcome; });
    try {
      if (mode === "join-error" || mode === "both-errors") child.emit("error", joinFailure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(finished, false, "an error or stop result cannot substitute for the actual close join");
      assert.deepEqual(events, mode === "exited" ? [] : ["stop SIGKILL"]);
      child.emit("close", 86);
      const outcome = await joining;
      if (mode === "running" || mode === "exited") assert.equal(outcome.status, "fulfilled");
      else {
        assert.equal(outcome.status, "rejected");
        if (outcome.status === "rejected") {
          assert.ok(outcome.reason instanceof AggregateError);
          if (mode === "both-errors") assert.deepEqual(outcome.reason.errors, [stopFailure, joinFailure]);
          if (mode === "stop-error") assert.deepEqual(outcome.reason.errors, [stopFailure]);
          if (mode === "join-error") assert.deepEqual(outcome.reason.errors, [joinFailure]);
          await assert.rejects(finishOwnedMcpFixture({ root: roots.root, stateDirectories: [roots.stateDirectory],
            owner: { stateDirectory: roots.stateDirectory, async close() { events.push("owner close"); } },
            hasPrimaryFailure: false, primaryFailure: undefined,
            async beforeClose() { throw outcome.reason; },
          }));
          assert.equal(events.at(-1), "owner close");
          assert.equal(existsSync(roots.root), true);
          assert.equal(existsSync(roots.stateDirectory), true);
        }
      }
    } finally { child.emit("close", 86); await joining; roots.dispose(); }
  });
}

test("C5 post-ready finalizer retains both exact roots and observes a close-rejected pending call after primary failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-finalizer-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-state-"));
  const primaryFailure = new Error("synthetic trigger-marker wait failure");
  const closeRejectedCall = new Error("synthetic close rejected pending call");
  let rejectCall!: (reason: unknown) => void;
  const call = new Promise<never>((_resolve, reject) => { rejectCall = reject; });
  const observedCall = observeMcpCall(call);
  let retainStateDirectory = false;
  try {
    const failure = await finishOwnedMcpFixture({
      root,
      primaryFailure,
      hasPrimaryFailure: true,
      owner: {
        stateDirectory: stateRoot,
        async close(options) {
          retainStateDirectory = options?.retainStateDirectory === true;
          rejectCall(closeRejectedCall);
        },
      },
      async settlePendingCall() {
        const outcome = await observedCall;
        assert.equal(outcome.status, "rejected");
        if (outcome.status === "rejected") assert.equal(outcome.reason, closeRejectedCall);
      },
    }).then(() => undefined, (error: unknown) => error);
    assert.equal(failure, primaryFailure);
    assert.equal(retainStateDirectory, true);
    assert.equal(existsSync(root), true);
    assert.equal(existsSync(stateRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("C5 post-ready call observer owns a rejection before finalizer settlement", async () => {
  const closeRejectedCall = new Error("synthetic close rejected pending call");
  let rejectCall!: (reason: unknown) => void;
  const call = new Promise<never>((_resolve, reject) => { rejectCall = reject; });
  const observedCall = observeMcpCall(call);
  rejectCall(closeRejectedCall);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const outcome = await observedCall;
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.reason, closeRejectedCall);
});

test("C5 post-ready fixture settles its owned call before asserting a controlled delayed trigger marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-ordering-"));
  const triggerMarker = join(root, "triggered.log");
  const delayedFailure = new Error("synthetic delayed line-bound transport failure");
  let rejectCall!: (reason: unknown) => void;
  let triggerWritten = false;
  const call = new Promise<never>((_resolve, reject) => { rejectCall = reject; });
  const observedCall = observeMcpCall(call);
  const delayedTrigger = setTimeout(() => {
    writeFileSync(triggerMarker, "triggered\n");
    triggerWritten = true;
    rejectCall(delayedFailure);
  }, 3_500);
  try {
    const outcome = await settlePostReadyCallAndAssertTrigger(observedCall, triggerMarker, () => undefined);
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, delayedFailure);
  } finally {
    clearTimeout(delayedTrigger);
    if (!triggerWritten) rejectCall(new Error("synthetic controlled trigger cancellation"));
    await observedCall;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("C5 post-ready finalizer aggregates primary and close cleanup failures without deleting either exact root", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-finalizer-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-state-"));
  const primaryFailure = new Error("synthetic primary failure");
  const cleanupFailure = new Error("synthetic close cleanup failure");
  try {
    const failure = await finishOwnedMcpFixture({
      root,
      primaryFailure,
      hasPrimaryFailure: true,
      owner: {
        stateDirectory: stateRoot,
        async close(options) {
          assert.equal(options?.retainStateDirectory, true);
          throw cleanupFailure;
        },
      },
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [primaryFailure, cleanupFailure]);
    assert.equal(existsSync(root), true);
    assert.equal(existsSync(stateRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("C5 post-ready finalizer deletes only after clean close with no primary failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-finalizer-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-state-"));
  try {
    await finishOwnedMcpFixture({
      root,
      primaryFailure: undefined,
      hasPrimaryFailure: false,
      owner: {
        stateDirectory: stateRoot,
        async close(options) {
          assert.equal(options?.retainStateDirectory, true);
          assert.equal(existsSync(stateRoot), true);
        },
      },
    });
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("C5 actual empty owned manager retains its exact state root when final cleanup preserves primary evidence", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aiboard-c5-mcp-project-"));
  const owned = await ownedManager(projectRoot, []);
  const stateRoot = owned.stateDirectory;
  let closeSucceeded = false;
  try {
    await owned.close({ retainStateDirectory: true });
    closeSucceeded = true;
    assert.equal(existsSync(stateRoot), true);
  } finally {
    if (!closeSucceeded) await owned.close().catch(() => undefined);
    rmSync(stateRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("live MCP status follows registered per-run managers and returns to configured stopped state", () => {
  const status: McpServerStatus = {
    name: "fixture",
    command: "fixture-command",
    status: "starting",
    toolCount: 0,
  };
  const registry = createLiveMcpStatusRegistry([
    { name: "fixture", command: "fixture-command" },
  ]);
  const registration = registry.register("run-live", { status: () => [{ ...status }] });
  assert.equal(registry.status()[0]?.status, "starting");
  Object.assign(status, { status: "ready", toolCount: 3 });
  assert.deepEqual(registry.status(), [{
    name: "fixture",
    command: "fixture-command",
    status: "ready",
    toolCount: 3,
  }]);
  registration.dispose();
  assert.deepEqual(registry.status(), [{
    name: "fixture",
    command: "fixture-command",
    status: "stopped",
    toolCount: 0,
  }]);
});

test("post-ready transport failure closes automatically and explicit close retries one blocked cleanup", async () => {
  let failTransport: ((error: Error) => void) | undefined;
  let closeAttempts = 0;
  let applicationRequestSent = false;
  const configured = syntheticMcpOptions("controlled", "controlled-fixture", [{ name: "lookup", inputSchema: { type: "object" } }]);
  const transportFactory: McpTransportFactory = {
    async open(request) {
      failTransport = request.onFailure;
      const writer = {
        async write(payload: Uint8Array) {
          const message = JSON.parse(Buffer.from(payload).toString("utf8")) as {
            id?: number;
            method?: string;
          };
          if (message.method === "tools/call") applicationRequestSent = true;
          if (message.method === "initialize") {
            await request.onOutput("stdout", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05" },
            })}\n`));
          } else if (message.method === "tools/list") {
            await request.onOutput("stdout", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", id: message.id, result: {
                tools: [{ name: "lookup", inputSchema: { type: "object" } }],
              },
            })}\n`));
          }
        },
      };
      await request.handshake(writer);
      return {
        ...writer,
        request: async (_owner, perform) => perform(writer),
        async closeVerified() {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("injected cleanup verification blocker");
        },
      };
    },
  };
  const manager = new McpManager({
    ...configured,
    cwd: process.cwd(),
    servers: [{ name: "controlled", command: "controlled-fixture" }],
    requestTimeoutMs: 5_000,
    transportFactory,
  });
  try {
    await manager.start();
    assert.equal(manager.status()[0]?.status, "ready");
    const pending = manager.toolEntries()[0]!.client.call("lookup", { query: "pending" }, configured.context);
    await waitFor(() => applicationRequestSent);
    failTransport!(new Error("controlled post-ready transport failure"));
    await assert.rejects(pending, /cleanup|transport|closed/i);
    await waitFor(() => closeAttempts === 1 &&
      /cleanup.*unverified/i.test(manager.status()[0]?.error ?? ""));
    assert.deepEqual(manager.status().map(({ status, toolCount }) => ({ status, toolCount })), [
      { status: "error", toolCount: 0 },
    ]);
    assert.match(manager.status()[0]?.error ?? "", /transport|cleanup/i);

    await Promise.all([manager.close(), manager.close()]);
    assert.equal(closeAttempts, 2);
    assert.equal(manager.status()[0]?.status, "stopped");
  } finally {
    await manager.close().catch(() => undefined);
    await manager.close().catch(() => undefined);
  }
});

test("a terminal failure during transport opening cannot be overwritten as ready", async () => {
  let closeAttempts = 0;
  const configured = syntheticMcpOptions("opening", "opening-fixture", [{ name: "unsafe_ready", inputSchema: { type: "object" } }]);
  const transportFactory: McpTransportFactory = {
    async open(request) {
      const writer = {
        async write(payload: Uint8Array) {
          const message = JSON.parse(Buffer.from(payload).toString("utf8")) as {
            id?: number;
            method?: string;
          };
          const result = message.method === "initialize"
            ? { protocolVersion: "2024-11-05" }
            : { tools: [{ name: "unsafe_ready", inputSchema: { type: "object" } }] };
          if (message.id !== undefined) {
            await request.onOutput("stdout", Buffer.from(`${JSON.stringify({
              jsonrpc: "2.0", id: message.id, result,
            })}\n`));
          }
        },
      };
      await request.handshake(writer);
      request.onFailure(new Error("terminal failure before open returned"));
      return {
        ...writer,
        async closeVerified() { closeAttempts += 1; },
      };
    },
  };
  const manager = new McpManager({
    ...configured,
    cwd: process.cwd(),
    servers: [{ name: "opening", command: "opening-fixture" }],
    transportFactory,
  });

  await manager.start();
  await assert.rejects(manager.toolEntries()[0]!.client.call("unsafe_ready", {}, configured.context), /transport|closed/i);
  await waitFor(() => closeAttempts === 1);
  assert.deepEqual(manager.status().map(({ status, toolCount }) => ({ status, toolCount })), [
    { status: "error", toolCount: 0 },
  ]);
  assert.match(manager.status()[0]?.error ?? "", /transport|closed/i);
  assert.doesNotMatch(manager.status()[0]?.error ?? "", /cleanup verification failed/i);
  await manager.close();
  assert.equal(manager.status()[0]?.status, "stopped");
});
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";

const here = dirname(fileURLToPath(import.meta.url));
const tsxPath = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));

test("MCP stdio schemas become audited native tools with artifact-backed images", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const fixture = join(here, "fixtures", "mcp-server.mjs");
  const owned = await ownedManager(root, [
    { name: "docs", command: `"${process.execPath}" "${fixture}"` },
  ]);
  const manager = owned.manager;
  try {
    await manager.start();
    assert.deepEqual(manager.status().map((server) => ({ name: server.name, status: server.status, toolCount: server.toolCount })), [
      { name: "docs", status: "ready", toolCount: 1 },
    ]);
    const broker = new ToolBroker({
      permissionProfile: "full",
      executionGrants: owned.run.executionGrants,
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createMcpTools(manager, artifacts)) broker.register(tool);
    assert.equal(broker.definitions()[0].name, "mcp.docs.lookup");
    const result = await broker.invoke({
      type: "tool_call",
      callId: "mcp-lookup",
      name: "mcp.docs.lookup",
      arguments: { query: "runner" },
    }, {
      runId: owned.run.runId,
      sessionId: "session_mcp",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.content.some((block) => block.type === "text" && block.text === "found:runner"), true);
    const image = result.content.find((block) => block.type === "artifact");
    assert.ok(image?.type === "artifact");
    assert.equal(image.mediaType, "image/png");
    assert.equal((await artifacts.get(image.hash)).toString(), "image-bytes");
  } finally {
    await owned.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP calls require approval outside Full Access", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-permission-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const fixture = join(here, "fixtures", "mcp-server.mjs");
  const owned = await ownedManager(root, [
    { name: "docs", command: `"${process.execPath}" "${fixture}"` },
  ]);
  const manager = owned.manager;
  try {
    await manager.start();
    const broker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createMcpTools(manager, artifacts)) broker.register(tool);
    const result = await broker.invoke({
      type: "tool_call",
      callId: "mcp-lookup",
      name: "mcp.docs.lookup",
      arguments: { query: "runner" },
    }, {
      runId: "run_mcp",
      sessionId: "session_mcp",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(result.error?.code, "approval_required");
  } finally {
    await owned.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("required strict MCP Docker fixture refuses unavailable Docker instead of silently skipping", () => {
  const previousRequired = process.env.RUNNER_V2_REQUIRE_DOCKER;
  const previousCli = process.env.RUNNER_V2_TEST_DOCKER_CLI;
  try {
    process.env.RUNNER_V2_REQUIRE_DOCKER = "1";
    process.env.RUNNER_V2_TEST_DOCKER_CLI = join(tmpdir(), "missing-task12-docker-cli");
    assert.throws(() => availableDockerNodeFixture(), /required strict MCP Docker OCI integration/i);
  } finally {
    if (previousRequired === undefined) delete process.env.RUNNER_V2_REQUIRE_DOCKER;
    else process.env.RUNNER_V2_REQUIRE_DOCKER = previousRequired;
    if (previousCli === undefined) delete process.env.RUNNER_V2_TEST_DOCKER_CLI;
    else process.env.RUNNER_V2_TEST_DOCKER_CLI = previousCli;
  }
});
test("strict public MCP uses the separately attested portable image command and refuses unsafe host identities", { timeout: 120_000 }, async (t) => {
  const docker = availableDockerNodeFixture();
  if (!docker) return t.skip("Docker with the local node:24-slim image is unavailable; no pull or weakening attempted.");
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-strict-identity-"));
  const providerIds = strictMcpProviderIds();
  const stateDirectories: string[] = [];
  const owners: OwnedMcpFixture[] = [];
  const captureState = (stateDirectory: string) => { stateDirectories.push(stateDirectory); captureMcpFixtureRoots(root, stateDirectory); };
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  const fixture = join(projectDirectory, "mcp-server.mjs");
  copyFileSync(join(here, "fixtures", "mcp-server.mjs"), fixture);
  let portable: Awaited<ReturnType<typeof strictOwnedManager>> | undefined;
  let unavailable: Awaited<ReturnType<typeof strictOwnedManager>> | undefined;
  let absolute: Awaited<ReturnType<typeof strictOwnedManager>> | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    portable = await strictOwnedManager(
      projectDirectory,
      docker,
      providerIds[0]!,
      { name: "portable", command: `node ${quoteCommandArgument(fixture)}` },
      captureState,
    );
    owners.push(portable);
    assert.equal(isAbsolute(portable.launches[0]!.executablePath), true);
    assert.equal(portable.launches[0]!.imageExecutable, "node");
    assert.match(portable.launches[0]!.executableDigest, /^[a-f0-9]{64}$/);
    await portable.manager.start();
    assert.deepEqual(portable.manager.status().map(({ status, toolCount }) => ({ status, toolCount })), [
      { status: "ready", toolCount: 1 },
    ], JSON.stringify(portable.manager.status()));
    const result = await portable.invoke("lookup", { query: "strict" });
    const second = await portable.invoke("lookup", { query: "same-session-fresh-grant" });
    assert.equal(second.content?.[0]?.text, "found:same-session-fresh-grant");
    assert.deepEqual(portable.mcpSessionStates(), ["active"], "strict isolation must survive first-grant revocation under durable session ownership");
    assert.equal(result.content?.[0]?.text, "found:strict");
    await waitFor(() => portable!.retainedOutputCount() === 0, 5_000);
    await portable.close({ retainStateDirectory: true });
    assert.equal(dockerOwnedContainers(docker, providerIds[0]!), "");

    unavailable = await strictOwnedManager(
      projectDirectory,
      docker,
      providerIds[1]!,
      { name: "unavailable", command: "git --version" },
      captureState,
    );
    owners.push(unavailable);
    assert.equal(unavailable.launches[0]!.imageExecutable, "git");
    await unavailable.manager.start();
    assert.equal(unavailable.manager.status()[0]?.status, "error");
    assert.match(unavailable.manager.status()[0]?.error ?? "", /isolation|provider|launch|image|executable|unavailable|discovery/i);
    assert.equal(dockerOwnedContainers(docker, providerIds[1]!), "");

    absolute = await strictOwnedManager(
      projectDirectory,
      docker,
      providerIds[2]!,
      { name: "absolute", command: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(fixture)}` },
      captureState,
    );
    owners.push(absolute);
    assert.equal(absolute.launches[0]!.imageExecutable, undefined);
    await absolute.manager.start();
    assert.equal(absolute.manager.status()[0]?.status, "ready", "host discovery is not permission to launch in the strict image");
    await assert.rejects(absolute.invoke("lookup", { query: "must-refuse" }), /isolation|provider|image|executable|unavailable/i);
    assert.equal(absolute.manager.status()[0]?.status, "error");
    assert.match(absolute.manager.status()[0]?.error ?? "", /isolation|provider|launch|image|executable|unavailable|discovery/i);
    assert.equal(dockerOwnedContainers(docker, providerIds[2]!), "");
  } catch (error) {
    hasPrimaryFailure = true; primaryFailure = error;
  } finally {
    await finishOwnedMcpFixture({ root, owners, stateDirectories, primaryFailure, hasPrimaryFailure,
      verify: [
        async () => { assert.ok(portable); assert.deepEqual(portable.mcpSessionStates(), ["released"]); },
        ...[unavailable, absolute].filter((owner) => owner !== undefined).map((owner) => async () => {
          assert.equal(owner.mcpSessionStates().every((state) => state === "released"), true);
        }),
        ...providerIds.map((providerId) => async () => { assert.equal(dockerOwnedContainers(docker, providerId), ""); }),
      ],
    });
  }
});

test("strict OCI MCP containment retires a detached session-changing descendant", { timeout: 120_000 }, async (t) => {
  const docker = availableDockerNodeFixture();
  if (!docker) return t.skip("Docker with the local node:24-slim image is unavailable; no pull or weakening attempted.");
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-strict-detached-"));
  const projectDirectory = join(root, "project");
  mkdirSync(projectDirectory);
  const fixture = join(projectDirectory, "mcp-descendant-server.mjs");
  copyFileSync(join(here, "fixtures", "mcp-descendant-server.mjs"), fixture);
  const providerId = `sd-${randomUUID().replaceAll("-", "")}`;
  let owned: Awaited<ReturnType<typeof strictOwnedManager>> | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    owned = await strictOwnedManager(
      projectDirectory,
      docker,
      providerId,
      { name: "detached", command: `node ${quoteCommandArgument(fixture)} --lazy --detached` },
    );
    await owned.manager.start();
    const result = await owned.invoke("probe", {});
    const text = result.content?.[0]?.text;
    if (typeof text !== "string") assert.fail("Detached MCP probe did not return text content.");
    assert.match(text, /^tree-alive:\d+$/);
    assert.notEqual(dockerOwnedContainers(docker, providerId), "", "detached workload must run inside the owned OCI boundary");
    await owned.close({ retainStateDirectory: true });
    assert.equal(dockerOwnedContainers(docker, providerId), "", "whole-container release must retire detached descendants");
    assert.deepEqual(owned.mcpSessionStates(), ["released"]);
  } catch (error) {
    hasPrimaryFailure = true; primaryFailure = error;
  } finally {
    await finishOwnedMcpFixture({
      root,
      owner: owned,
      primaryFailure,
      hasPrimaryFailure,
      verify: [async () => { assert.equal(dockerOwnedContainers(docker, providerId), ""); }],
    });
  }
});

test("public MCP manager process-group scope closes its inherited server tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-owned-tree-"));
  const descendantMarker = join(root, "descendant.pid");
  const serverMarker = join(root, "server.pid");
  const fixture = join(here, "fixtures", "mcp-descendant-server.mjs");
  let owned: Awaited<ReturnType<typeof ownedManager>> | undefined;
  const stateDirectories: string[] = [];
  let serverPid = 0;
  let descendantPid = 0;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    owned = await ownedManager(root, [{ name: "tree",
      command: `"${process.execPath}" "${fixture}" "${descendantMarker}" "${serverMarker}" --lazy`,
    }], undefined, (stateDirectory) => { stateDirectories.push(stateDirectory); captureMcpFixtureRoots(root, stateDirectory); });
    await owned.manager.start();
    await owned.invoke("probe", {});
    await waitFor(() => existsSync(serverMarker) && existsSync(descendantMarker));
    serverPid = Number(readFileSync(serverMarker, "utf8"));
    descendantPid = Number(readFileSync(descendantMarker, "utf8"));
    assert.equal(processExists(serverPid), true);
    assert.equal(processExists(descendantPid), true);

    await owned.close({ retainStateDirectory: true });

    await waitFor(() => !processExists(serverPid) && !processExists(descendantPid));
    assert.equal(processExists(serverPid), false);
    assert.equal(processExists(descendantPid), false);
  } catch (error) {
    hasPrimaryFailure = true; primaryFailure = error;
  } finally {
    await finishOwnedMcpFixture({ root, owner: owned, stateDirectories, primaryFailure, hasPrimaryFailure,
      verify: [
        async () => { assert.ok(owned); assert.deepEqual(owned.mcpSessionStates(), ["released"]); },
        async () => { await verifyMcpTreeAbsent(serverMarker, descendantMarker); },
      ],
    });
  }
});

for (const mode of ["self-exit", "oversized-line"] as const) {
  // This positive setup now includes an actual lazy first launch/handshake;
  // the trigger still must self-exit (not merely time out), exactly once. Tight
  // write/request deadline behavior is covered separately by gated RPC tests.
  // Cold lazy invocation includes initialize, tools/list, and the actual RPC: three existing phase windows.
  const requestTimeoutMs = mode === "oversized-line" ? 60_000 : 3 * 15_000;
  // Bounded whole-fixture allowance: initialize/tools-list request windows,
  // initialized notification write, existing PID marker wait, real call,
  // release observation, and one verified-close window. All values are
  // existing portable limits; this changes no product request or cleanup limit.
  const fixtureTimeoutMs =
    (2 * requestTimeoutMs) + Math.min(requestTimeoutMs, 30_000) + 3_000 +
    requestTimeoutMs + 30_000 + 30_000;
  test(`post-ready ${mode} failure rejects the call and releases its exact process session`, { timeout: fixtureTimeoutMs }, async () => {
    const root = mkdtempSync(join(tmpdir(), `aiboard-mcp-post-ready-${mode}-`));
    const captureRoot = (kind: "project" | "state", path: string): void => {
      if (process.env.AIBOARD_C5_CAPTURE_ROOTS === "1") {
        process.stderr.write(`C5 post-ready ${mode} ${kind} root: ${path}\n`);
      }
    };
    captureRoot("project", root);
    const pidMarker = join(root, "server.pid");
    const triggerMarker = join(root, "triggered.log");
    const fixture = join(here, "fixtures", "mcp-post-ready-failure-server.mjs");
    const startedAt = Date.now();
    const stages: string[] = [];
    const stage = (label: string) => { stages.push(`+${Date.now() - startedAt}ms ${label}`); };
    let owned: Awaited<ReturnType<typeof ownedManager>> | undefined;
    const stateDirectories: string[] = [];
    let serverPid = 0;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    let callOutcome: Promise<ObservedMcpCall<unknown>> | undefined;
    let primaryFailureCategory: string | undefined;
    let finalizerFailure: unknown;
    let hasFinalizerFailure = false;
    let finalizerFailureCategory: string | undefined;
    try {
      stage("manager construct begun");
      const fixtureOwner = await ownedManager(root, [{
        name: "failure",
        command: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(fixture)} ${mode} ${quoteCommandArgument(pidMarker)} ${quoteCommandArgument(triggerMarker)} --lazy`,
      }], mode === "oversized-line"
        ? { requestTimeoutMs, maximumLineBytes: 32 * 1024 }
        : { requestTimeoutMs }, (stateDirectory) => { stateDirectories.push(stateDirectory); captureRoot("state", stateDirectory); });
      owned = fixtureOwner;
      stage("manager constructed");
      await fixtureOwner.manager.start();
      stage("manager start complete");
      assert.equal(fixtureOwner.manager.status()[0]?.status, "ready");
      await fixtureOwner.invoke("probe", {});
      await waitFor(() => existsSync(pidMarker));
      serverPid = Number(readFileSync(pidMarker, "utf8"));
      assert.equal(processExists(serverPid), true);

      const call = fixtureOwner.invoke("trigger", {});
      const observedCall = observeMcpCall(call);
      callOutcome = observedCall;
      stage("call begun");
      const callResult = await settlePostReadyCallAndAssertTrigger(observedCall, triggerMarker, stage);
      assert.equal(callResult.status, "rejected");
      if (callResult.status === "rejected") {
        assert.ok(callResult.reason instanceof McpProtocolError);
        assert.equal(callResult.reason.outcome, "outcome_unknown", "an admitted crash cannot be called not sent");
        assert.ok(["mcp_write_outcome_unknown", "mcp_transport_unavailable", "mcp_output_limit"].includes(callResult.reason.code));
        assert.equal(fixtureOwner.manager.status()[0]?.error, callResult.reason.message);
      }
      try {
        await waitFor(() => fixtureOwner.manager.status()[0]?.status === "error" &&
          fixtureOwner.mcpSessionStates().every((state) => state === "released") &&
          !processExists(serverPid), 30_000);
      } catch (error) {
        throw new Error(`Post-ready cleanup did not settle: status=${JSON.stringify(fixtureOwner.manager.status())}; sessions=${JSON.stringify(fixtureOwner.mcpSessionStates())}; childAlive=${processExists(serverPid)}.`, { cause: error });
      }
      assert.equal(fixtureOwner.manager.status()[0]?.toolCount, 0);
      assert.ok(fixtureOwner.manager.status()[0]?.error, "the typed failed call remains published as an error");
      assert.doesNotMatch(fixtureOwner.manager.status()[0]?.error ?? "", /cleanup verification failed/i);
      assert.deepEqual(fixtureOwner.mcpSessionStates(), ["released"]);
      stage("release assertion reached");

      await fixtureOwner.manager.close();
      assert.equal(fixtureOwner.manager.status()[0]?.status, "stopped");
    } catch (error) {
      primaryFailure = error;
      hasPrimaryFailure = true;
      primaryFailureCategory = mcpFixtureFailureCategory(error);
      stage(`primary captured (${primaryFailureCategory})`);
    } finally {
      try {
        stage("finalizer begun");
        const observedCall = callOutcome;
        await finishOwnedMcpFixture({
          root,
          primaryFailure,
          hasPrimaryFailure,
          owner: owned,
          stateDirectories,
          settlePendingCall: observedCall ? async () => {
            const outcome = await observedCall;
            stage("call settled during finalizer");
            if (outcome.status === "fulfilled") {
              throw new Error("Post-ready MCP call fulfilled after fixture finalization began.");
            }
          } : undefined,
          verify: [
            async () => { assert.ok(owned); assert.deepEqual(owned.mcpSessionStates(), ["released"]); },
            async () => {
              assert.equal(Number.isSafeInteger(serverPid) && serverPid > 0, true);
              await waitFor(() => !processExists(serverPid), 5_000);
            },
          ],
        });
        stage("finalizer closed");
      } catch (error) {
        finalizerFailure = error;
        hasFinalizerFailure = true;
        finalizerFailureCategory = mcpFixtureFailureCategory(error);
        stage(`finalizer failed (${finalizerFailureCategory})`);
      }
      if (hasPrimaryFailure || hasFinalizerFailure) {
        process.stderr.write(`C5 post-ready ${mode} failure categories: primary=${primaryFailureCategory ?? "none"}; finalizer=${finalizerFailureCategory ?? "none"}\n`);
        process.stderr.write(`C5 post-ready ${mode} stages: ${stages.join("; ")}\n`);
      }
    }
    if (hasFinalizerFailure) throw finalizerFailure;
  });
}

test("recovered blocked MCP ownership prevents a replacement launch", async () => {
  let cleanupCalls = 0;
  const run = {
    streamingState: {
      listSessionIds: () => ["mcp-blocked"],
      readSession: () => ({
        state: "cleanup_blocked",
        actor: { role: "runner_internal", id: "mcp:blocked" },
        toolName: "mcp.transport.open",
      }),
    },
    streamingRuntime: {
      cleanupOwnedSession: async () => { cleanupCalls++; },
    },
  } as unknown as ExecutionHostRunBinding;

  await assert.rejects(
    cleanupRecoveredMcpTransports(run),
    /blocked|unreleased|replacement|cleanup/i,
  );
  assert.equal(cleanupCalls, 1, "uncertain ownership must receive one coordinator attempt before replacement is refused");
});

test("closing an owned MCP transport stops a sustained pending-output pump after its current delivery", async () => {
  let pendingOutput = true; let released = false; let cleanupCalls = 0; let deliveryCalls = 0;
  let resolveDeliveryStarted!: () => void; const deliveryStarted = new Promise<void>((resolve) => { resolveDeliveryStarted = resolve; });
  let resolveCurrentDelivery!: () => void; const currentDelivery = new Promise<void>((resolve) => { resolveCurrentDelivery = resolve; });
  let streamingSessionId = "";
  const facade = {
    authorizeFirstOperation: () => ({}), authorizeOperation: () => ({}),
    waitForOutput: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return pendingOutput; },
    request: async (_auth: unknown, _assertion: unknown, perform: (channel: {
      write(payload: Uint8Array, timeoutMs: number): Promise<void>;
      waitForOutput(signal?: AbortSignal): Promise<boolean>;
      deliverOutput(deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>): Promise<boolean>;
    }) => Promise<unknown>) => perform({ write: async () => undefined,
      waitForOutput: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return pendingOutput; },
      deliverOutput: async () => { deliveryCalls++; if (deliveryCalls === 1) { resolveDeliveryStarted(); await currentDelivery; } return true; },
    }),
  };
  const run = {
    runId: "run-sustained-output", executionGrants: { issue: async () => assert.fail("transport cannot mint replacement grants") },
    openStreaming: async (input: { sessionId: string; verifyHandshake: (channel: {
      write(payload: Uint8Array, timeoutMs: number): Promise<void>; waitForOutput(signal?: AbortSignal): Promise<boolean>;
      deliverOutput(deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>): Promise<boolean>;
    }) => Promise<string> }) => {
      streamingSessionId = input.sessionId;
      await input.verifyHandshake({ write: async () => undefined, waitForOutput: async () => new Promise<boolean>(() => undefined), deliverOutput: async () => false });
      return facade;
    },
    streamingRuntime: { cleanupOwnedSession: async ({ sessionId }: { sessionId: string }) => {
      assert.equal(sessionId, streamingSessionId); cleanupCalls++; released = true; return { released: true as const };
    } },
    streamingState: { readSession: () => ({ state: released ? "released" : "active" }) },
  } as unknown as ExecutionHostRunBinding;
  const server = { name: "sustained", command: "fixture-command" };
  const configDigest = mcpConfigurationDigest(server); const executableDigest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  const owner = { context: { runId: run.runId, sessionId: "real-agent", actor: { role: "worker" as const, id: "real-worker" }, callId: "actual-call", toolName: "mcp.sustained.stream", executionGrant: Object.freeze({}) as OpaqueExecutionGrant },
    envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } };
  const transport = await createExecutionHostMcpTransportFactory({ run, permissionProfile: "full", projectDirectory: process.cwd(),
    launches: [{ ...server, envelope: { paths: [], network: false, credentialNames: [] }, executablePath: process.execPath, arguments: [], configDigest, executableDigest }],
  }).open({ server, owner, expected: { name: server.name, configDigest, executableDigest, status: "ready", tools: [], cleanupVerified: true },
    handshake: async () => "c".repeat(64), onOutput: async () => undefined, onFailure: () => undefined });
  const pending = observeMcpCall(transport.request!(owner, async (writer) => {
    await writer.write(Buffer.from("request"), 100); return await new Promise<unknown>(() => undefined);
  }, 1000));
  await deliveryStarted;
  const close = transport.closeVerified();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cleanupCalls, 0, "owned cleanup must join the current coherent delivery before claiming release");
    resolveCurrentDelivery(); await close;
    assert.equal((await pending).status, "rejected");
    assert.equal(cleanupCalls, 1); assert.equal(deliveryCalls, 1, "closing cannot drain another frame under stale authority");
  } finally {
    pendingOutput = false; resolveCurrentDelivery(); await close; await pending;
  }
});

test("public MCP manager crash recovery cleans its exact launched server tree without relaunch", { timeout: 130_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-manager-crash-"));
  const projectDirectory = join(root, "project");
  const stateDirectory = join(root, "state");
  const readyMarker = join(root, "manager.ready");
  const serverMarker = join(root, "server.pid");
  const descendantMarker = join(root, "descendant.pid");
  mkdirSync(projectDirectory);
  mkdirSync(stateDirectory);
  captureMcpFixtureRoots(root, stateDirectory);
  const fixture = join(here, "fixtures", "mcp-manager-host-crash.mts");
  const owners: OwnedMcpFixture[] = [];
  let recoveryRun: ExecutionHostRunBinding | undefined;
  const ensureRecovery = async () => {
    if (recoveryRun) return recoveryRun;
    const recovery = await constructOwnedMcpFixture(stateDirectory, async (own) => {
      const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
      const host = own("host", createExecutionHost({
        projectRoot: projectDirectory, stateDirectory,
        artifacts: new ArtifactStore(join(stateDirectory, "artifacts")),
        ambientEnvironment,
        ...(process.platform === "win32" ? { processHostFacts: {
          portableDuplex: "verified" as const, windowsBatchArgv: "verified" as const,
          exactTreeBirth: "verified" as const, jobContainment: "unavailable" as const,
        } } : {}),
      }));
      const run = own("run", await host.bindRun({
        runId: "mcp-manager-crash-recovery", permissionProfile: "full",
        capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract,
        capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
      }));
      return { run };
    });
    owners.push(recovery);
    recoveryRun = recovery.run;
    await recoveryRun.recover({ maxRecords: 1_024, timeoutMs: 30_000 });
    return recoveryRun;
  };
  let crashed: ChildProcess | undefined;
  let closed: Promise<ObservedMcpCall<number | null>> | undefined;
  let stderr = "";
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    crashed = spawn(process.execPath, [tsxPath, fixture, stateDirectory, projectDirectory,
      readyMarker, serverMarker, descendantMarker], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    closed = observeOwnedMcpWrapper(crashed);
    crashed.stderr!.setEncoding("utf8");
    crashed.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    // Discovery plus lazy handshake must finish before the intentional wrapper crash.
    await waitFor(() => existsSync(readyMarker) && existsSync(serverMarker) && existsSync(descendantMarker), 70_000);
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => { closeDeadline = setTimeout(() => reject(new Error("Owned MCP crash wrapper did not close within 10000ms.")), 10_000); }),
    ]).finally(() => { clearTimeout(closeDeadline); });
    if (outcome.status === "rejected") throw outcome.reason;
    assert.equal(outcome.value, 86, stderr);
    const serverPid = Number(readFileSync(serverMarker, "utf8"));
    const descendantPid = Number(readFileSync(descendantMarker, "utf8"));
    assert.equal(processExists(serverPid), true);
    assert.equal(processExists(descendantPid), true);
    const run = await ensureRecovery();
    const sessionIds = run.streamingState.listSessionIds();
    assert.equal(sessionIds.length, 1);
    assert.equal(run.streamingState.readSession(sessionIds[0]!)?.state, "active");
    await cleanupRecoveredMcpTransports(run);
    await verifyMcpTreeAbsent(serverMarker, descendantMarker, 10_000);
    assert.equal(run.streamingState.readSession(sessionIds[0]!)?.state, "released");
    await cleanupRecoveredMcpTransports(run);
    assert.deepEqual(run.streamingState.listSessionIds(), sessionIds);
    assert.equal(processExists(serverPid), false);
    assert.equal(processExists(descendantPid), false);
  } catch (error) {
    hasPrimaryFailure = true; primaryFailure = error;
  } finally {
    await finishOwnedMcpFixture({ root, owners, stateDirectories: [stateDirectory], primaryFailure, hasPrimaryFailure,
      async beforeClose() {
        const failures: unknown[] = [];
        try {
          if (!crashed || !closed) throw new Error("Owned MCP crash wrapper is unavailable.");
          await stopAndJoinOwnedMcpWrapper(crashed, closed);
        } catch (error) { failures.push(error); }
        try { await cleanupRecoveredMcpTransports(await ensureRecovery()); }
        catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "Authenticated MCP crash cleanup failed.");
      },
      verify: [
        async () => {
          assert.ok(recoveryRun);
          assert.deepEqual(readMcpSessionStates(recoveryRun.runRoot), ["released"]);
        },
        async () => { await verifyMcpTreeAbsent(serverMarker, descendantMarker); },
      ],
    });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP process state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function verifyMcpTreeAbsent(serverMarker: string, descendantMarker: string, timeoutMs = 5_000, isAlive = processExists): Promise<void> {
  const pids = [serverMarker, descendantMarker].map((marker) => Number(readFileSync(marker, "utf8")));
  assert.equal(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0), true, "Exact fixture PID evidence is required for absence observation.");
  await waitFor(() => pids.every((pid) => !isAlive(pid)), timeoutMs);
  assert.equal(pids.every((pid) => !isAlive(pid)), true);
}

function captureMcpFixtureRoots(root: string, stateDirectory: string): void {
  if (process.env.AIBOARD_C5_CAPTURE_ROOTS === "1") console.log(JSON.stringify({ root, stateDirectory }));
}

function readMcpSessionStates(runRoot: string) {
  const kernel = openSqliteStreamingSessionStore(join(runRoot, "streaming-sessions.sqlite"),
    readFileSync(join(runRoot, "streaming-sessions.key")), { readOnly: true });
  try { return kernel.store.listSessionIds().map((sessionId) => kernel.store.readBySession(sessionId)?.state); }
  finally { kernel.store.close(); }
}

let ownedManagerSequence = 0;

type OwnedMcpFixture = Readonly<{
  stateDirectory: string;
  close(options?: Readonly<{ retainStateDirectory?: boolean }>): Promise<void>;
}>;

type ObservedMcpCall<T> =
  | Readonly<{ status: "fulfilled"; value: T }>
  | Readonly<{ status: "rejected"; reason: unknown }>;

function observeMcpCall<T>(call: Promise<T>): Promise<ObservedMcpCall<T>> {
  return call.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function settlePostReadyCallAndAssertTrigger<T>(
  observedCall: Promise<ObservedMcpCall<T>>,
  triggerMarker: string,
  stage: (label: string) => void,
): Promise<ObservedMcpCall<T>> {
  const callResult = await observedCall;
  stage("call settled");
  assert.equal(
    existsSync(triggerMarker),
    true,
    "MCP trigger marker was not written before the call settled.",
  );
  stage("trigger observed");
  return callResult;
}

function mcpFixtureFailureCategory(error: unknown): string {
  if (error instanceof AggregateError) return "aggregate";
  if (!(error instanceof Error)) return typeof error;
  if (error.message.startsWith("MCP request timed out:")) return "request-timeout";
  if (error.message === "Timed out waiting for MCP process state.") return "state-observation-timeout";
  if (error.message.startsWith("Post-ready cleanup did not settle:")) return "release-observation-failure";
  if (error.message === "Post-ready MCP call fulfilled after fixture finalization began.") return "unexpected-call-fulfillment";
  if (error.message === "MCP trigger marker was not written before the call settled.") return "missing-trigger-marker";
  return error.name === "AbortError" ? "aborted" : "error";
}

async function finishOwnedMcpFixture(input: Readonly<{
  root: string;
  primaryFailure: unknown;
  hasPrimaryFailure: boolean;
  owner?: OwnedMcpFixture;
  owners?: readonly OwnedMcpFixture[];
  stateDirectories?: readonly string[];
  beforeClose?: () => Promise<void>;
  settlePendingCall?: () => Promise<void>;
  verify?: readonly (() => Promise<void>)[];
}>): Promise<void> {
  const cleanupFailures: unknown[] = [];
  const owners = input.owners ?? (input.owner ? [input.owner] : []);
  const stateDirectories = [...new Set([...(input.stateDirectories ?? []), ...owners.map((owner) => owner.stateDirectory)])];
  try { await input.beforeClose?.(); } catch (error) { cleanupFailures.push(error); }
  if (owners.length === 0) {
    cleanupFailures.push(new Error("Post-ready fixture owner is unavailable."));
  }
  for (const owner of owners) {
    try {
      await owner.close({ retainStateDirectory: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await input.settlePendingCall?.();
  } catch (error) {
    cleanupFailures.push(error);
  }
  for (const verify of input.verify ?? []) {
    try { await verify(); } catch (error) { cleanupFailures.push(error); }
  }
  if (cleanupFailures.length === 0 && !input.hasPrimaryFailure) {
    try {
      for (const stateDirectory of stateDirectories) {
        rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
      rmSync(input.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (input.hasPrimaryFailure || cleanupFailures.length > 0) {
    const failures = [...(input.hasPrimaryFailure ? [input.primaryFailure] : []), ...cleanupFailures];
    const seen = new Set<unknown>();
    const describe = (failure: unknown, depth = 0): unknown => {
      if (depth > 6 || seen.has(failure)) return { bounded: true };
      seen.add(failure);
      return failure instanceof Error ? { name: failure.name, message: failure.message,
        ...(failure instanceof AggregateError ? { errors: failure.errors.map((error) => describe(error, depth + 1)) } : {}),
        ...(failure.cause === undefined ? {} : { cause: describe(failure.cause, depth + 1) }) } : { kind: typeof failure };
    };
    console.log(`MCP fixture original failure chain: ${JSON.stringify({ root: input.root, failures: failures.map((failure) => describe(failure)) })}`);
  }
  if (input.hasPrimaryFailure || cleanupFailures.length > 0) {
    const failures = [...(input.hasPrimaryFailure ? [input.primaryFailure] : []), ...cleanupFailures];
    const seen = new Set<unknown>();
    const describe = (failure: unknown, depth = 0): unknown => {
      if (depth > 6 || seen.has(failure)) return { bounded: true };
      seen.add(failure);
      return failure instanceof Error ? { name: failure.name, message: failure.message,
        ...(failure instanceof AggregateError ? { errors: failure.errors.map((error) => describe(error, depth + 1)) } : {}),
        ...(failure.cause === undefined ? {} : { cause: describe(failure.cause, depth + 1) }) } : { kind: typeof failure };
    };
    console.log(`MCP fixture original failure chain: ${JSON.stringify({ root: input.root, failures: failures.map((failure) => describe(failure)) })}`);
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      input.hasPrimaryFailure ? [input.primaryFailure, ...cleanupFailures] : cleanupFailures,
      `Post-ready fixture cleanup could not be verified; evidence roots: ${[input.root, ...stateDirectories].join(", ")}.`,
    );
  }
  if (input.hasPrimaryFailure) throw input.primaryFailure;
}

type McpCloserKind = "manager" | "run" | "internal" | "host";

async function constructOwnedMcpFixture<T>(
  stateDirectory: string,
  construct: (own: <O extends { close(): Promise<unknown> }>(kind: McpCloserKind, owner: O) => O) => Promise<T>,
): Promise<T & OwnedMcpFixture> {
  const closers: { kind: McpCloserKind; owner: { close(): Promise<unknown> } }[] = [];
  let constructionComplete = false;
  let closeComplete = false;
  let closePromise: Promise<void> | undefined;
  const close = async (options?: Readonly<{ retainStateDirectory?: boolean }>) => {
    if (closeComplete) return;
    if (closePromise) return await closePromise;
    const attempt = (async () => {
      const failures: unknown[] = [];
      for (const kind of ["manager", "run", "internal", "host"] as const) {
        for (const entry of closers.filter((entry) => entry.kind === kind)) {
          try {
            await entry.owner.close();
          } catch (firstError) {
            if (!constructionComplete) {
              failures.push(firstError);
              continue;
            }
            try {
              await entry.owner.close();
            } catch (retryError) {
              failures.push(new AggregateError([firstError, retryError], `Owned MCP ${kind} cleanup failed after one exact retry.`));
            }
          }
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Owned MCP test cleanup failed.");
      if (!options?.retainStateDirectory) rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      closeComplete = true;
    })();
    closePromise = attempt;
    try { await attempt; } finally { if (closePromise === attempt) closePromise = undefined; }
  };
  try {
    const result = await construct((kind, owner) => { closers.push({ kind, owner }); return owner; });
    constructionComplete = true;
    return Object.freeze({ ...result, stateDirectory, close });
  } catch (primaryFailure) {
    const failures: unknown[] = [primaryFailure];
    try { await close({ retainStateDirectory: true }); } catch (error) {
      if (error instanceof AggregateError) failures.push(...error.errors); else failures.push(error);
    }
    throw new AggregateError(failures, `Owned MCP fixture construction failed; state retained at ${stateDirectory}.`);
  }
}

function observeOwnedMcpWrapper(child: {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}): Promise<ObservedMcpCall<number | null>> {
  // Observe both errors and close immediately. An error is reported after the
  // actual close event has joined the directly spawned wrapper's lifecycle.
  let spawnFailure: unknown;
  let hasSpawnFailure = false;
  return observeMcpCall(new Promise<number | null>((resolve, reject) => {
    child.once("error", (error) => { hasSpawnFailure = true; spawnFailure = error; });
    child.once("close", (code) => { if (hasSpawnFailure) reject(spawnFailure); else resolve(code); });
  }));
}

async function stopAndJoinOwnedMcpWrapper(
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill">,
  closed: Promise<ObservedMcpCall<number | null>>,
): Promise<void> {
  const failures: unknown[] = [];
  if (child.exitCode === null && child.signalCode === null) {
    try { if (!child.kill("SIGKILL")) throw new Error("Owned MCP wrapper stop was not accepted."); }
    catch (error) { failures.push(error); }
  }
  const outcome = await closed;
  if (outcome.status === "rejected") failures.push(outcome.reason);
  if (failures.length) throw new AggregateError(failures, "Owned MCP wrapper stop/join failed.");
}

async function ownedManager(
  projectDirectory: string,
  servers: readonly McpServerSpec[],
  managerOptions?: Readonly<{ requestTimeoutMs?: number; maximumLineBytes?: number }>,
  onStateDirectoryCreated?: (stateDirectory: string) => void,
) {
  const stateDirectory = mkdtempSync(join(tmpdir(), "aiboard-mcp-owned-state-"));
  onStateDirectoryCreated?.(stateDirectory);
  return constructOwnedMcpFixture(stateDirectory, async (own) => {
  const artifacts = new ArtifactStore(join(stateDirectory, "artifacts"));
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const host = own("host", createExecutionHost({
    projectRoot: projectDirectory,
    stateDirectory,
    artifacts,
    ambientEnvironment,
    ...(process.platform === "win32" ? {
      processHostFacts: {
        portableDuplex: "verified" as const,
        windowsBatchArgv: "verified" as const,
        exactTreeBirth: "verified" as const,
        jobContainment: "unavailable" as const,
      },
    } : {}),
  }));
  const internal = own("internal", createRunnerInternalExecutionContext({
    projectDirectory,
    stateDirectory,
    processKernel: host.internalProcesses,
    ambientEnvironment,
  }));
  const attestation = await internal.attestConfiguredCapabilities({
    mcpServers: servers,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  const launches = await internal.resolveMcpRuntimeLaunches({
    servers,
    attestation: attestation.mcp,
  });
  const runId = `mcp-owned-test-${++ownedManagerSequence}`;
  const run = own("run", await host.bindRun({
    runId,
    permissionProfile: "full",
    capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  }));
  const discoverer = internal.createMcpDiscoveryExecutor({ runId: run.runId, servers, attestation: attestation.mcp, requestTimeoutMs: managerOptions?.requestTimeoutMs ?? 5000 });
  let discovered: McpDiscoveryResult;
  try { discovered = await discoverer.discover(); } finally { await discoverer.close(); }
  const manager = own("manager", new McpManager({
    runId: run.runId, discovery: discovered,
    reattest: () => internal.resolveMcpRuntimeLaunches({ servers, attestation: attestation.mcp }),
    cwd: projectDirectory,
    servers,
    ...managerOptions,
    transportFactory: createExecutionHostMcpTransportFactory({
      run,
      permissionProfile: "full",
      projectDirectory,
      launches,
    }),
  }));
  return { manager, run, invoke: (tool: string, args: Record<string, unknown>) => fixtureMcpCall(manager, run, projectDirectory, "full", tool, args),
    mcpSessionStates() {
      return readMcpSessionStates(run.runRoot);
    },
  };
  });
}

async function strictOwnedManager(
  projectDirectory: string,
  docker: string,
  providerId: string,
  supplied: { name: string; command: string },
  onStateDirectoryCreated?: (stateDirectory: string) => void,
) {
  const server: McpServerSpec = { ...supplied, envelope: { paths: [{ path: projectDirectory, mode: "read" }], network: false } };
  const stateDirectory = mkdtempSync(join(tmpdir(), "aiboard-mcp-strict-state-"));
  onStateDirectoryCreated?.(stateDirectory);
  return constructOwnedMcpFixture(stateDirectory, async (own) => {
  const artifacts = new ArtifactStore(join(stateDirectory, "artifacts"));
  const config: RunnerCapabilitiesConfig = {
    extensions: [],
    languageServers: [],
    isolationProviders: [{
      id: providerId,
      type: "oci",
      cliPath: docker,
      image: "node:24-slim",
      allowNetwork: false,
    }],
  };
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const host = own("host", createExecutionHost({
    projectRoot: projectDirectory,
    stateDirectory,
    artifacts,
    ambientEnvironment,
    ...(process.platform === "win32" ? {
      processHostFacts: {
        portableDuplex: "verified" as const,
        windowsBatchArgv: "verified" as const,
        exactTreeBirth: "verified" as const,
        jobContainment: "unavailable" as const,
      },
    } : {}),
  }));
  const internal = own("internal", createRunnerInternalExecutionContext({
    projectDirectory,
    stateDirectory,
    processKernel: host.internalProcesses,
    ambientEnvironment,
  }));
  const attestation = await internal.attestConfiguredCapabilities({
    mcpServers: [server],
    capabilitiesConfig: config,
  });
  const launches = await internal.resolveMcpRuntimeLaunches({
    servers: [server],
    attestation: attestation.mcp,
  });
  const run = own("run", await host.bindRun({
    runId: providerId,
    permissionProfile: "project",
    capabilityContract: { digest: "b".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: config,
  }));
  const discoverer = internal.createMcpDiscoveryExecutor({ runId: run.runId, servers: [server], attestation: attestation.mcp, requestTimeoutMs: 1000 });
  let discovered: McpDiscoveryResult;
  try { discovered = await discoverer.discover(); } finally { await discoverer.close(); }
  const manager = own("manager", new McpManager({
    runId: run.runId, discovery: discovered,
    reattest: () => internal.resolveMcpRuntimeLaunches({ servers: [server], attestation: attestation.mcp }),
    cwd: projectDirectory,
    servers: [server],
    requestTimeoutMs: 30_000,
    transportFactory: createExecutionHostMcpTransportFactory({
      run,
      permissionProfile: "project",
      projectDirectory,
      launches,
    }),
  }));
  return { manager, run, launches, invoke: (tool: string, args: Record<string, unknown>) => fixtureMcpCall(manager, run, projectDirectory, "project", tool, args),
    mcpSessionStates() {
      return readMcpSessionStates(run.runRoot);
    },
    retainedOutputCount() {
      const backendRoot = join(run.runRoot, "process-backend");
      if (!existsSync(backendRoot)) return 0;
      return readdirSync(backendRoot).reduce((count, directory) => {
        const output = join(backendRoot, directory, "channel", "output");
        return count + (existsSync(output) ? readdirSync(output).length : 0);
      }, 0);
    },
  };
  });
}

function availableDockerNodeFixture(): string | undefined {
  try {
    const explicit = process.env.RUNNER_V2_TEST_DOCKER_CLI;
    const executable = explicit || (process.platform === "win32"
      ? execFileSync("where.exe", ["docker"], { encoding: "utf8" }).split(/\r?\n/)[0]
      : execFileSync("which", ["docker"], { encoding: "utf8" }).trim());
    if (!executable || !isAbsolute(executable)) return undefined;
    execFileSync(executable, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    execFileSync(executable, ["image", "inspect", "node:24-slim"], { stdio: "ignore" });
    return executable;
  } catch (error) {
    if (process.env.RUNNER_V2_REQUIRE_DOCKER === "1") {
      throw new Error("Required strict MCP Docker OCI integration is unavailable or node:24-slim is not prepared.", { cause: error });
    }
    return undefined;
  }
}

function dockerOwnedContainers(docker: string, providerId: string,
  inspect: (docker: string, args: readonly string[]) => string = (executable, args) => execFileSync(executable, args, { encoding: "utf8" }),
): string {
  return inspect(docker, [
    "ps",
    "--all",
    "--quiet",
    "--filter", "label=ai-board.runner-v2.owned=true",
    "--filter", `label=ai-board.runner-v2.provider=${providerId}`,
  ]).trim();
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}


let fixtureMcpCallOrdinal = 0;
async function fixtureMcpCall(manager: McpManager, run: ExecutionHostRunBinding, workspace: string,
  permissionProfile: "full" | "project", name: string, arguments_: Record<string, unknown>) {
  const entry = manager.toolEntries().find((item) => item.tool.name === name);
  assert.ok(entry, "the fixture call must name an actually discovered tool");
  const envelope = fixedMcpEnvelope(entry.client.spec.envelope);
  const binding = { runId: run.runId, sessionId: "actual-mcp-fixture-agent", actor: { role: "worker" as const, id: "actual-mcp-fixture-worker" },
    callId: `fixture-call-${++fixtureMcpCallOrdinal}`, toolName: `mcp.${entry.client.spec.name}.${name}`, permissionProfile };
  const grant = await run.executionGrants.issue({ ...binding, workspacePath: workspace,
    access: envelope.paths.map((entry) => ({ path: entry.path, mode: entry.mode })),
    networkApproved: envelope.network, destructiveApproved: entry.tool.annotations?.destructiveHint !== false, externalApproved: false });
  try { return await entry.client.call(name, arguments_, { ...binding, workspacePath: workspace, executionGrant: grant }); }
  finally { await run.executionGrants.revoke(grant, "completed"); }
}

function syntheticMcpOptions(name: string, command: string, tools: readonly McpDiscoveryTool[]) {
  const server = { name, command }; const configDigest = mcpConfigurationDigest(server); const executableDigest = "a".repeat(64);
  const runId = `synthetic-${name}`;
  const discovery: McpDiscoveryResult = { version: 1, runId,
    principal: { principalId: "synthetic-discovery", purpose: "mcp_discovery", role: "runner_internal", runId, callId: "discovery", deadlineMs: 1000 },
    servers: [{ name, configDigest, executableDigest, tools, schemaDigest: canonicalMcpDigest(tools), status: "ready", cleanupVerified: true }] };
  return { runId, discovery, reattest: async () => [{ ...server, configDigest, executableDigest,
    executablePath: process.execPath, arguments: [], envelope: { paths: [], network: false, credentialNames: [] } }],
    context: { runId, sessionId: "synthetic-agent", actor: { role: "worker" as const, id: "synthetic-worker" },
      callId: "first-real-synthetic-call", toolName: `mcp.${name}.${tools[0]!.name}`, workspacePath: process.cwd(),
      executionGrant: Object.freeze({}) as OpaqueExecutionGrant } };
}
