import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  ExecutionIsolationError,
  createExecutionIsolationProviderRegistration,
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
  readExecutionEnforcementState,
  type ExecutionIsolationProvider,
} from "../src/execution-isolation-provider.js";

const execFileAsync = promisify(execFile);
const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const enforcementWriter = fileURLToPath(new URL("./fixtures/execution-enforcement-writer.mts", import.meta.url));

test("durable enforcement projection rejects unknown or forged state", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-enforcement-corrupt-"));
  const path = join(root, "state.json");
  try {
    await writeFile(path, JSON.stringify({
      version: 1, boundary: "provider_specific_not_universal_security_boundary",
      records: [{ occurredAt: new Date().toISOString(), runId: "run", invocationId: "inv", grantId: "grant", status: "active", enforcement: "write_confinement_exact_grant", disclosure: "provider_specific_not_universal_boundary", access: [], universalBoundary: true }],
    }));
    await assert.rejects(readExecutionEnforcementState(path), (error) =>
      error instanceof ExecutionIsolationError && error.code === "isolation_recovery_blocked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable enforcement projection enforces exact byte, record, access, and field bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-enforcement-bounds-"));
  const path = join(root, "state.json");
  const record = {
    occurredAt: "2026-08-28T10:00:00.000Z", runId: "r", invocationId: "i", grantId: "g",
    status: "active", enforcement: "write_confinement_exact_grant",
    disclosure: "provider_specific_not_universal_boundary", providerId: "provider",
    implementationDigest: "a".repeat(64), leaseId: "lease", access: [],
  };
  const state = (records: unknown[]) => ({ version: 1, boundary: "provider_specific_not_universal_security_boundary", records });
  try {
    await writeFile(path, JSON.stringify(state(Array.from({ length: 1_000 }, () => record))));
    assert.equal((await readExecutionEnforcementState(path)).records.length, 1_000);
    await writeFile(path, JSON.stringify(state([{
      ...record, runId: "x".repeat(512),
      access: Array.from({ length: 256 }, (_, index) => ({ canonicalPath: join(root, `exact-${index}`), mode: "read" })),
    }])));
    assert.equal((await readExecutionEnforcementState(path)).records[0]?.access.length, 256);
    for (const value of [
      state(Array.from({ length: 1_001 }, () => record)),
      state([{ ...record, access: Array.from({ length: 257 }, (_, index) => ({ canonicalPath: join(root, `over-${index}`), mode: "read" })) }]),
      state([{ ...record, runId: "x".repeat(513) }]),
    ]) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(readExecutionEnforcementState(path), (error) =>
        error instanceof ExecutionIsolationError && error.code === "isolation_recovery_blocked");
    }
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assert.rejects(readExecutionEnforcementState(path), (error) =>
      error instanceof ExecutionIsolationError && error.code === "isolation_recovery_blocked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable enforcement projection rejects invalid lifecycle, paths, aliases, and uncorrelated summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-enforcement-semantic-"));
  const path = join(root, "state.json");
  const strict = {
    occurredAt: "2026-08-28T10:00:00.000Z", runId: "run", invocationId: "inv", grantId: "grant",
    status: "active", enforcement: "write_confinement_exact_grant", disclosure: "provider_specific_not_universal_boundary",
    providerId: "provider", implementationDigest: "a".repeat(64), leaseId: "lease", access: [],
  };
  const state = (records: unknown[], recoverySummaries?: unknown[]) => ({
    version: 1, boundary: "provider_specific_not_universal_security_boundary", records,
    ...(recoverySummaries ? { recoverySummaries } : {}),
  });
  try {
    const historical = { ...strict, status: "blocked", blocker: "No verified provider enforces exact-grant write confinement.",
      providerId: undefined, implementationDigest: undefined, leaseId: undefined };
    await writeFile(path, JSON.stringify(state([historical])));
    assert.equal((await readExecutionEnforcementState(path)).records[0]?.status, "selection_blocked");
    for (const value of [
      state([{ ...strict, providerId: undefined }]),
      state([{ ...historical, providerId: "partial-provider" }]),
      state([{ ...strict, status: "unconfined_explicit_full", enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full" }]),
      state([{ ...strict, access: [{ canonicalPath: "relative", mode: "write" }] }]),
      state([{ ...strict, access: [{ canonicalPath: root, mode: "read" }, { canonicalPath: root, mode: "write" }] }]),
      state([], [{ occurredAt: strict.occurredAt, providerId: "provider", cleanedCount: 1, blockerCount: 0, blockers: [] }]),
      state([{ ...strict, status: "cleaned" }], [{ occurredAt: strict.occurredAt, providerId: "provider", cleanedCount: 1,
        blockerCount: 0, blockers: [], operationId: "0".repeat(64), leaseIds: ["lease"] }]),
      state([], [{ occurredAt: strict.occurredAt, providerId: "provider", cleanedCount: 0, blockerCount: 1,
        blockers: ["unmatched"], leaseIds: [], operationId: createHash("sha256").update(JSON.stringify({
          providerId: "provider", occurredAt: strict.occurredAt, leaseIds: [], cleaned: 0, blockers: 1,
        })).digest("hex") }]),
    ]) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(readExecutionEnforcementState(path), (error) =>
        error instanceof ExecutionIsolationError && error.code === "isolation_recovery_blocked");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable enforcement projection preserves concurrent writes across OS processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-enforcement-processes-"));
  const statePath = join(root, "state.json");
  const barrier = join(root, "start");
  try {
    const children = ["left", "right"].map((writer) => execFileAsync(process.execPath, [
      tsxCli, enforcementWriter, statePath, join(root, writer), barrier, writer,
    ]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(barrier, "go");
    await Promise.all(children);
    const state = await readExecutionEnforcementState(statePath);
    assert.equal(state.records.length, 40);
    assert.deepEqual(new Set(state.records.map((record) => record.runId)), new Set(["run-left", "run-right"]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("durable enforcement projection rolls beyond record capacity without invalid retained state", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-enforcement-rolling-"));
  const statePath = join(root, "state.json");
  const barrier = join(root, "start");
  try {
    const child = execFileAsync(process.execPath, [tsxCli, enforcementWriter, statePath, join(root, "writer"), barrier, "rolling", "1005"]);
    await writeFile(barrier, "go");
    await child;
    const state = await readExecutionEnforcementState(statePath);
    assert.equal(state.records.length, 1_000);
    assert.equal(state.records.every((record) => record.status === "unconfined_explicit_full"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selects strict isolation by verified semantic confinement and exact consumed grant", async () => {
  const fixture = await isolationFixture();
  try {
    const provider = fakeProvider("fixture-oci");
    const registry = createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({
        stableProviderId: "fixture-oci",
        codeDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        provider,
      }),
    ]);
    const selector = createExecutionIsolationSelector(registry, fixture.selectorOptions);
    const selection = await selector.acquire({
      permissionProfile: "project",
      intent: fixture.intent,
      grant: fixture.claims,
    });

    assert.equal(selection.enforcement, "write_confinement_exact_grant");
    assert.equal(selection.disclosure, "provider_specific_not_universal_boundary");
    assert.deepEqual(selection.lease.grantedAccess, fixture.claims.access);
    assert.equal(provider.acquisitions, 1);
    await assert.rejects(
      selector.acquire({
        permissionProfile: "project",
        intent: fixture.intent,
        grant: fixture.claims,
      }),
      (error) => error instanceof ExecutionIsolationError &&
        error.code === "isolation_grant_mismatch",
    );
    assert.equal(provider.acquisitions, 1);
    await selector.release(selection);
    assert.equal(provider.releases, 1);
    assert.deepEqual(selector.activeLeases(), []);
    assert.equal(await fixture.authority.revoke(fixture.grant, "completed"), true);
    assert.equal(provider.releases, 1, "terminal release must dispose the authority listener");
  } finally {
    await fixture.close();
  }
});

test("one consumed grant is global across selectors and authority revocation releases its lease", async () => {
  const fixture = await isolationFixture();
  try {
    const provider = fakeProvider("fixture-global");
    const registry = createExecutionIsolationRegistry([createExecutionIsolationProviderRegistration({
      stableProviderId: "fixture-global",
      codeDigest: "a".repeat(64),
      configDigest: "b".repeat(64),
      provider,
    })]);
    const first = createExecutionIsolationSelector(registry, fixture.selectorOptions);
    const second = createExecutionIsolationSelector(registry, fixture.selectorOptions);
    const outcomes = await Promise.allSettled([first, second].map((selector) => selector.acquire({
      permissionProfile: "project",
      intent: fixture.intent,
      grant: fixture.claims,
    })));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(provider.acquisitions, 1);
    const foreign = createExecutionGrantAuthority();
    const foreignAttempts = await Promise.allSettled([
      foreign.revoke(fixture.grant, "completed"),
      Promise.resolve().then(() => foreign.consume(fixture.grant, fixture.binding)),
    ]);
    assert.equal(foreignAttempts.every((outcome) => outcome.status === "rejected" &&
      outcome.reason instanceof Error && "code" in outcome.reason && outcome.reason.code === "grant_forged"), true);
    await foreign.revokeAll("restart");
    assert.equal(provider.releases, 0);
    assert.equal(first.activeLeases().length + second.activeLeases().length, 1);
    assert.equal(await fixture.authority.revoke(fixture.grant, "completed"), true);
    assert.equal(provider.releases, 1);
    assert.deepEqual(first.activeLeases(), []);
    assert.deepEqual(second.activeLeases(), []);
  } finally {
    await fixture.close();
  }
});

test("concurrent release, duplicate release, and authority revoke share one terminal cleanup", async () => {
  for (const fail of [false, true]) {
    const fixture = await isolationFixture();
    try {
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      const provider = fakeProvider(`fixture-terminal-${fail}`, { releaseGate: gate, releaseFails: fail });
      const statePath = join(fixture.root, `terminal-${fail}.json`);
      const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
        createExecutionIsolationProviderRegistration({
          stableProviderId: `fixture-terminal-${fail}`, codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider,
        }),
      ]), { ...fixture.selectorOptions, statePath });
      const selection = await selector.acquire({ permissionProfile: "project", intent: fixture.intent, grant: fixture.claims });
      const wave = [selector.release(selection), selector.release(selection), fixture.authority.revoke(fixture.grant, "completed")];
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(provider.releases, 1);
      unblock();
      const outcomes = await Promise.allSettled(wave);
      assert.equal(provider.releases, 1);
      const terminal = (await readExecutionEnforcementState(statePath)).records.filter((record) =>
        record.status === "revoked" || record.status === "blocked");
      assert.equal(terminal.length, 1);
      if (fail) {
        assert.equal(outcomes.every((outcome) => outcome.status === "rejected"), true);
        assert.equal(selector.activeLeases()[0]?.state, "revocation_failed");
        provider.releaseFails = false;
        await selector.release(selection);
        assert.equal(provider.releases, 2);
      } else {
        assert.equal(outcomes.every((outcome) => outcome.status === "fulfilled"), true);
        assert.deepEqual(selector.activeLeases(), []);
      }
    } finally { await fixture.close(); }
  }
});

test("provider-cleaned projection failure retains retry ownership without repeating cleanup", async () => {
  const fixture = await isolationFixture();
  try {
    const provider = fakeProvider("fixture-projection-retry");
    const statePath = join(fixture.root, "projection-retry.json");
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({ stableProviderId: "fixture-projection-retry", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
    ]), { ...fixture.selectorOptions, statePath });
    const selection = await selector.acquire({ permissionProfile: "project", intent: fixture.intent, grant: fixture.claims });
    const valid = await import("node:fs/promises").then((fs) => fs.readFile(statePath));
    await writeFile(statePath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await assert.rejects(selector.release(selection), (error) =>
      error instanceof ExecutionIsolationError && error.code === "isolation_recovery_blocked");
    await assert.rejects(selector.release(selection), (error) =>
      error instanceof ExecutionIsolationError && error.code === "isolation_recovery_blocked");
    assert.equal(provider.releases, 1);
    assert.equal(selector.activeLeases()[0]?.state, "released");
    await writeFile(statePath, valid);
    const retry = await Promise.allSettled([selector.release(selection), fixture.authority.revoke(fixture.grant, "completed")]);
    assert.equal(retry.every((outcome) => outcome.status === "fulfilled"), true);
    assert.equal(provider.releases, 1);
    assert.deepEqual(selector.activeLeases(), []);
  } finally { await fixture.close(); }
});

test("strict profiles fail typed before acquire for unavailable, partial, broken, expired, or false claims", async () => {
  const fixture = await isolationFixture();
  try {
    for (const [name, mutation] of [
      ["unavailable", { state: "unavailable" }],
      ["partial", { state: "partial" }],
      ["unverified", { verified: false }],
      ["dishonest", { exact: false }],
      ["expired", { expiresAt: "2026-08-28T09:59:59.000Z" }],
      ["wrong identity", { implementationDigest: "0".repeat(64) }],
    ] as const) {
      const providerId = `fixture-${name.replace(" ", "-")}`;
      const provider = fakeProvider(providerId, mutation);
      const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
        createExecutionIsolationProviderRegistration({
          stableProviderId: providerId,
          codeDigest: "a".repeat(64),
          configDigest: "b".repeat(64),
          provider,
        }),
      ]), { clock: () => new Date("2026-08-28T10:00:00.000Z") });
      await assert.rejects(
        selector.acquire({
          permissionProfile: "project",
          intent: fixture.intent,
          grant: fixture.claims,
        }),
        (error) => error instanceof ExecutionIsolationError &&
          error.code === "isolation_capability_unavailable",
      );
      assert.equal(provider.acquisitions, 0, name);
    }

    const empty = createExecutionIsolationSelector(
      createExecutionIsolationRegistry([]),
      fixture.selectorOptions,
    );
    await assert.rejects(
      empty.acquire({ permissionProfile: "project", intent: fixture.intent, grant: fixture.claims }),
      (error) => error instanceof ExecutionIsolationError &&
        error.code === "isolation_capability_unavailable",
    );
  } finally {
    await fixture.close();
  }
});

test("strict selection rejects local native execution merely labelled as confined", async () => {
  const fixture = await isolationFixture();
  try {
    const provider = fakeProvider("native-labelled-confined", { mechanism: "local-native-execution" });
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({ stableProviderId: "native-labelled-confined", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
    ]), fixture.selectorOptions);
    await assert.rejects(
      selector.acquire({ permissionProfile: "project", intent: fixture.intent, grant: fixture.claims }),
      (error) => error instanceof ExecutionIsolationError && error.code === "isolation_capability_unavailable",
    );
    assert.equal(provider.acquisitions, 0);
  } finally { await fixture.close(); }
});

test("Full is the sole ordinary bypass and reports it without invoking a provider", async () => {
  const fixture = await isolationFixture("full");
  try {
    const provider = fakeProvider("fixture-full");
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({
        stableProviderId: "fixture-full",
        codeDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        provider,
      }),
    ]), fixture.selectorOptions);
    const selection = await selector.acquire({
      permissionProfile: "full",
      intent: fixture.intent,
      grant: fixture.claims,
    });
    assert.deepEqual(selection, {
      enforcement: "unconfined_explicit_full",
      disclosure: "unconfined_explicit_full",
    });
    assert.equal(provider.acquisitions, 0);
  } finally {
    await fixture.close();
  }
});

test("durable enforcement projection reopens Full, strict lease, revocation, and blocker state", async () => {
  const strict = await isolationFixture();
  const full = await isolationFixture("full");
  const statePath = join(strict.root, "enforcement.json");
  try {
    const provider = fakeProvider("fixture-durable", { mechanism: "docker-compatible-oci", ociIdentity: true });
    const registry = createExecutionIsolationRegistry([createExecutionIsolationProviderRegistration({
      stableProviderId: "fixture-durable", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider,
    })]);
    const strictSelector = createExecutionIsolationSelector(registry, { ...strict.selectorOptions, statePath });
    const selection = await strictSelector.acquire({ permissionProfile: "project", intent: strict.intent, grant: strict.claims });
    assert.equal(selection.enforcement, "write_confinement_exact_grant");
    if (selection.enforcement !== "write_confinement_exact_grant") throw new Error("strict fixture bypassed confinement");
    await strictSelector.release(selection);
    await strictSelector.recoverOwnedLeases();
    const fullSelector = createExecutionIsolationSelector(createExecutionIsolationRegistry([]), { ...full.selectorOptions, statePath });
    await fullSelector.acquire({ permissionProfile: "full", intent: full.intent, grant: full.claims });
    const reopened = createExecutionIsolationSelector(createExecutionIsolationRegistry([]), { statePath });
    const state = await reopened.enforcementState();
    assert.equal(state.boundary, "provider_specific_not_universal_security_boundary");
    assert.deepEqual(state.records.map((record) => record.status), ["active", "revoked", "cleaned", "unconfined_explicit_full"]);
    assert.equal(state.records[0]?.providerId, "fixture-durable");
    assert.equal(state.records[0]?.leaseId, selection.lease.leaseId);
    assert.equal(state.records[0]?.immutableImageId, `sha256:${"1".repeat(64)}`);
    assert.equal("nonce" in state.records[0]!, false);
  } finally {
    await strict.close();
    await full.close();
  }
});

test("restart projection correlates multiple exact cleaned and blocked lease transitions", async () => {
  const first = await isolationFixture();
  const second = await isolationFixture();
  const statePath = join(first.root, "partial-recovery.json");
  try {
    const provider = fakeProvider("fixture-partial-recovery", { partialRecovery: true });
    const registry = createExecutionIsolationRegistry([createExecutionIsolationProviderRegistration({
      stableProviderId: "fixture-partial-recovery", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider,
    })]);
    const left = createExecutionIsolationSelector(registry, { ...first.selectorOptions, statePath });
    const [one, two] = await Promise.all([
      left.acquire({ permissionProfile: "project", intent: first.intent, grant: first.claims }),
      left.acquire({ permissionProfile: "project", intent: { ...second.intent, invocationId: "invocation-2" }, grant: second.claims }),
    ]);
    assert.equal(one.enforcement, "write_confinement_exact_grant");
    assert.equal(two.enforcement, "write_confinement_exact_grant");
    if (two.enforcement !== "write_confinement_exact_grant") throw new Error("fixture bypassed strict recovery");
    await left.recoverOwnedLeases();
    const reopened = await createExecutionIsolationSelector(createExecutionIsolationRegistry([]), { statePath }).enforcementState();
    const active = reopened.records.filter((record) => record.status === "active");
    const terminal = reopened.records.filter((record) => record.status === "cleaned" || record.status === "blocked");
    assert.equal(active.length, 2);
    assert.deepEqual(new Set(terminal.map((record) => record.leaseId)), new Set(active.map((record) => record.leaseId)));
    assert.deepEqual(terminal.map((record) => record.status), ["cleaned", "blocked"]);
    assert.deepEqual({ ...reopened.recoverySummaries?.at(-1), operationId: undefined, leaseIds: undefined }, {
      occurredAt: "2026-08-28T10:00:00.000Z", providerId: "fixture-partial-recovery",
      cleanedCount: 1, blockerCount: 1, blockers: ["fixture partial cleanup blocker"], operationId: undefined, leaseIds: undefined,
    });
    assert.match(reopened.recoverySummaries?.at(-1)?.operationId ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(new Set(reopened.recoverySummaries?.at(-1)?.leaseIds), new Set(terminal.map((record) => record.leaseId!)));
    assert.deepEqual(left.activeLeases().map((lease) => lease.leaseId), [two.lease.leaseId]);
    await first.authority.revoke(first.grant, "completed");
    assert.equal(provider.releases, 0, "cleaned recovery must dispose its grant listener");
    await second.authority.revoke(second.grant, "completed");
    assert.equal(provider.releases, 1, "blocked recovery must retain its owned listener");
  } finally { await first.close(); await second.close(); }
});

test("recovery replays durable cleaned evidence until projection and acknowledgement both settle", async () => {
  for (const failure of ["projection", "ack"] as const) {
    const fixture = await isolationFixture();
    try {
      const provider = fakeProvider(`fixture-handoff-${failure}`, { acknowledgementFails: failure === "ack" });
      const statePath = join(fixture.root, `handoff-${failure}.json`);
      const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
        createExecutionIsolationProviderRegistration({ stableProviderId: `fixture-handoff-${failure}`, codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
      ]), { ...fixture.selectorOptions, statePath });
      await selector.acquire({ permissionProfile: "project", intent: fixture.intent, grant: fixture.claims });
      const valid = await import("node:fs/promises").then((fs) => fs.readFile(statePath));
      if (failure === "projection") await writeFile(statePath, Buffer.alloc(1024 * 1024 + 1, 0x20));
      const first = await selector.recoverOwnedLeases();
      assert.equal(first[0]?.cleaned, 0);
      assert.equal(selector.activeLeases().length, 1);
      if (failure === "projection") await writeFile(statePath, valid);
      else provider.acknowledgementFails = false;
      const second = await selector.recoverOwnedLeases();
      assert.equal(second[0]?.cleaned, 1);
      assert.deepEqual(selector.activeLeases(), []);
      assert.equal((await readExecutionEnforcementState(statePath)).records.filter((record) => record.status === "cleaned").length, 1);
      await fixture.authority.revoke(fixture.grant, "completed");
      assert.equal(provider.releases, 0, "acknowledged recovery must dispose the grant listener");
    } finally { await fixture.close(); }
  }
});

test("recovery never acknowledges a newly appended operation whose complete evidence exceeds projection capacity", async () => {
  const fixture = await isolationFixture();
  try {
    const access = Array.from({ length: 256 }, (_, index) => ({
      canonicalPath: join(fixture.root, `bounded-root-${index}-${"x".repeat(3_980)}`),
      mode: "write" as const,
    }));
    const provider = fakeProvider("fixture-protected-capacity", {
      recoveryTransitions: [{
        status: "cleaned", runId: "run", invocationId: "capacity-invocation", grantId: "capacity-grant",
        leaseId: "capacity-lease", providerId: "fixture-protected-capacity", implementationDigest: registeredImplementationDigest("fixture-protected-capacity"),
        access, cleanupToken: "capacity-cleanup", cleanedAt: "2026-08-28T10:00:00.000Z",
      }],
    });
    const statePath = join(fixture.root, "protected-capacity.json");
    const prior = Buffer.from(JSON.stringify({
      version: 1,
      boundary: "provider_specific_not_universal_security_boundary",
      records: [{
        occurredAt: "2026-08-27T10:00:00.000Z", runId: "old-run", invocationId: "old-invocation", grantId: "old-grant",
        status: "unconfined_explicit_full", enforcement: "unconfined_explicit_full", disclosure: "unconfined_explicit_full", access: [],
      }],
    }));
    await writeFile(statePath, prior);
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({ stableProviderId: "fixture-protected-capacity", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
    ]), { ...fixture.selectorOptions, statePath });

    const recovery = await selector.recoverOwnedLeases();

    assert.equal(recovery[0]?.cleaned, 0);
    assert.equal(provider.acknowledgements, 0);
    assert.deepEqual(await import("node:fs/promises").then((fs) => fs.readFile(statePath)), prior);
    assert.equal((await readExecutionEnforcementState(statePath)).records.length, 1);
  } finally { await fixture.close(); }
});

test("recovery evicts an older complete group but never the newly appended group by timestamp or sort order", async () => {
  const fixture = await isolationFixture();
  try {
    const recoveryTransitions: import("../src/execution-isolation-provider.js").ExecutionIsolationCleanupTransition[] = [
      capacityTransition("fixture-protected-rolling", "old-lease", "2026-08-28T10:00:00.000Z", boundedAccess(fixture.root, "old")),
    ];
    const provider = fakeProvider("fixture-protected-rolling", { recoveryTransitions });
    const statePath = join(fixture.root, "protected-rolling.json");
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({ stableProviderId: "fixture-protected-rolling", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
    ]), { ...fixture.selectorOptions, statePath });

    const firstRecovery = await selector.recoverOwnedLeases();
    assert.equal(firstRecovery[0]?.cleaned, 1, JSON.stringify(firstRecovery));
    recoveryTransitions.splice(0, 1,
      capacityTransition("fixture-protected-rolling", "new-lease", "2020-01-01T00:00:00.000Z", boundedAccess(fixture.root, "new")),
    );
    assert.equal((await selector.recoverOwnedLeases())[0]?.cleaned, 1);

    const state = await readExecutionEnforcementState(statePath);
    assert.deepEqual(state.records.filter((record) => record.status === "cleaned").map((record) => record.leaseId), ["new-lease"]);
    assert.deepEqual(state.recoverySummaries?.map((summary) => summary.leaseIds), [["new-lease"]]);
    assert.equal(state.records[0]?.occurredAt, "2020-01-01T00:00:00.000Z");
    assert.equal(provider.acknowledgements, 2);
  } finally { await fixture.close(); }
});

test("capacity-blocked recovery retains its tombstone and later persists the identical group once capacity is available", async () => {
  const fixture = await isolationFixture();
  try {
    const providerId = "fixture-protected-retry";
    const transition = capacityTransition(providerId, "retry-lease", "2026-08-28T10:00:00.000Z", []);
    const provider = fakeProvider(providerId, { recoveryTransitions: [transition] });
    const statePath = join(fixture.root, "protected-retry.json");
    const priorRecords = Array.from({ length: 1_000 }, (_, index) => activeProjectionRecord(index));
    await writeFile(statePath, JSON.stringify({
      version: 1, boundary: "provider_specific_not_universal_security_boundary", records: priorRecords,
    }));
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({ stableProviderId: providerId, codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
    ]), { ...fixture.selectorOptions, statePath });

    assert.equal((await selector.recoverOwnedLeases())[0]?.cleaned, 0);
    assert.equal(provider.acknowledgements, 0);
    assert.equal((await readExecutionEnforcementState(statePath)).records.length, 1_000);

    await writeFile(statePath, JSON.stringify({
      version: 1, boundary: "provider_specific_not_universal_security_boundary", records: priorRecords.slice(1),
    }));
    assert.equal((await selector.recoverOwnedLeases())[0]?.cleaned, 1);
    const recovered = await readExecutionEnforcementState(statePath);
    const terminal = recovered.records.filter((record) => record.status === "cleaned");
    assert.equal(provider.acknowledgements, 1);
    assert.equal(provider.releases, 0, "projection retry must not invoke local release cleanup");
    assert.deepEqual(terminal.map((record) => ({ leaseId: record.leaseId, recoveryOperationId: record.recoveryOperationId })), [{
      leaseId: transition.leaseId,
      recoveryOperationId: recovered.recoverySummaries?.[0]?.operationId,
    }]);
    assert.deepEqual(recovered.recoverySummaries?.[0]?.leaseIds, [transition.leaseId]);
  } finally { await fixture.close(); }
});

test("dishonest recovery counts, duplicates, identities, and contradictory transitions fail closed", async () => {
  const fixture = await isolationFixture();
  try {
    const exact = {
      status: "cleaned" as const, runId: "run", invocationId: "invocation", grantId: "grant",
      leaseId: "lease", providerId: "dishonest", implementationDigest: "a".repeat(64), access: fixture.claims.access,
      cleanupToken: "cleanup-lease", cleanedAt: "2026-08-28T10:00:00.000Z",
    };
    for (const result of [
      { cleaned: 1, blockers: [], transitions: [] },
      { cleaned: 0, blockers: [], transitions: [{ ...exact, status: "blocked" as const, blocker: "hidden", cleanupToken: undefined, cleanedAt: undefined }] },
      { cleaned: 0, blockers: ["extra"], transitions: [] },
      { cleaned: 0, blockers: ["wrong"], transitions: [{ ...exact, status: "blocked" as const, blocker: "actual", cleanupToken: undefined, cleanedAt: undefined }] },
      { cleaned: 2, blockers: [], transitions: [exact, exact] },
      { cleaned: 1, blockers: [], transitions: [{ ...exact, providerId: "other" }] },
      { cleaned: 1, blockers: ["contradiction"], transitions: [exact, { ...exact, status: "blocked" as const, blocker: "contradiction", cleanupToken: undefined, cleanedAt: undefined }] },
    ]) {
      const provider = fakeProvider("dishonest");
      provider.recoverOwned = async () => result;
      const statePath = join(fixture.root, `dishonest-${Math.random()}.json`);
      const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
        createExecutionIsolationProviderRegistration({ stableProviderId: "dishonest", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider }),
      ]), { statePath });
      const recovery = await selector.recoverOwnedLeases();
      assert.equal(recovery[0]?.cleaned, 0);
      assert.equal(recovery[0]?.blockers.length, 1);
      assert.deepEqual((await readExecutionEnforcementState(statePath)).records, []);
    }
  } finally { await fixture.close(); }
});

test("release failure remains visible and restart cleanup invokes only owned provider leases", async () => {
  const fixture = await isolationFixture();
  try {
    const provider = fakeProvider("fixture-cleanup", { releaseFails: true });
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({
        stableProviderId: "fixture-cleanup",
        codeDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        provider,
      }),
    ]), { ...fixture.selectorOptions, statePath: join(fixture.root, "cleanup-recovery.json") });
    await selector.acquire({
      permissionProfile: "project",
      intent: fixture.intent,
      grant: fixture.claims,
    });
    await assert.rejects(
      fixture.authority.revoke(fixture.grant, "completed"),
      (error) => error instanceof AggregateError && /cleanup blocker/.test(error.message),
    );
    assert.equal(selector.activeLeases()[0]?.state, "revocation_failed");
    provider.releaseFails = false;
    const recovered = await selector.recoverOwnedLeases();
    assert.deepEqual(recovered, [{ providerId: "fixture-cleanup", cleaned: 1, blockers: [] }]);
    assert.deepEqual(selector.activeLeases(), []);
    assert.equal(provider.recoveries, 1);
  } finally {
    await fixture.close();
  }
});

function fakeProvider(providerId: string, mutation: {
  state?: "enforced" | "partial" | "unavailable";
  verified?: boolean;
  exact?: boolean;
  expiresAt?: string;
  implementationDigest?: string;
  releaseFails?: boolean;
  mechanism?: string;
  ociIdentity?: boolean;
  partialRecovery?: boolean;
  releaseGate?: Promise<void>;
  acknowledgementFails?: boolean;
  recoveryTransitions?: import("../src/execution-isolation-provider.js").ExecutionIsolationCleanupTransition[];
} = {}): ExecutionIsolationProvider & {
  acquisitions: number;
  releases: number;
  recoveries: number;
  acknowledgements: number;
  releaseFails: boolean;
  acknowledgementFails: boolean;
} {
  const cleanupTransitions: import("../src/execution-isolation-provider.js").ExecutionIsolationCleanupTransition[] = [];
  const provider = {
    acquisitions: 0,
    releases: 0,
    recoveries: 0,
    acknowledgements: 0,
    releaseFails: mutation.releaseFails ?? false,
    acknowledgementFails: mutation.acknowledgementFails ?? false,
    async attest() {
      return {
        attestationVersion: 1,
        providerId,
        verified: mutation.verified ?? true,
        mechanism: mutation.mechanism ?? "fixture",
        ...(mutation.ociIdentity ? {
          executableIdentity: { path: "/explicit/docker", digest: "2".repeat(64) },
          imageIdentity: { configuredReference: "fixture/image", immutableId: `sha256:${"1".repeat(64)}` },
        } : {}),
        implementationDigest: mutation.implementationDigest,
        exactGrantWriteConfinement: mutation.exact ?? true,
        expiresAt: mutation.expiresAt,
        capabilities: {
          tree_termination: "enforced",
          crash_cleanup: "enforced",
          verified_emptiness: "enforced",
          write_confinement: mutation.state ?? "enforced",
        },
      };
    },
    async acquire(request: Parameters<ExecutionIsolationProvider["acquire"]>[0]) {
      provider.acquisitions += 1;
      const lease = {
        leaseId: `lease-${request.grant.grantId}`,
        providerId: request.providerId,
        invocationId: request.intent.invocationId,
        grantId: request.grant.grantId,
        grantedAccess: request.grant.access,
        acquiredAt: "2026-08-28T10:00:00.000Z",
        state: "active" as const,
        providerIdentity: request.implementationDigest,
        ...(mutation.ociIdentity ? { immutableImageId: `sha256:${"1".repeat(64)}` } : {}),
      };
      cleanupTransitions.push({
        status: "cleaned", runId: request.intent.runId, invocationId: lease.invocationId,
        grantId: lease.grantId, leaseId: lease.leaseId, providerId: lease.providerId,
        implementationDigest: lease.providerIdentity, immutableImageId: lease.immutableImageId,
        access: lease.grantedAccess, cleanupToken: `cleanup-${lease.leaseId}`, cleanedAt: "2026-08-28T10:00:00.000Z",
      });
      return lease;
    },
    async release() {
      provider.releases += 1;
      if (mutation.releaseGate) await mutation.releaseGate;
      if (provider.releaseFails) throw new Error("fixture release failed");
    },
    async recoverOwned() {
      provider.recoveries += 1;
      const transitions = (mutation.recoveryTransitions ?? cleanupTransitions).map((transition, index) => {
        if (!mutation.partialRecovery || index !== 1) return transition;
        const { cleanupToken: _cleanupToken, cleanedAt: _cleanedAt, ...blocked } = transition;
        return { ...blocked, status: "blocked" as const, blocker: "fixture partial cleanup blocker" };
      });
      const blockers = transitions.filter((transition) => transition.status === "blocked").map((transition) => transition.blocker!);
      return { cleaned: transitions.filter((transition) => transition.status === "cleaned").length, blockers, transitions };
    },
    async acknowledgeRecovery(transitions: readonly import("../src/execution-isolation-provider.js").ExecutionIsolationCleanupTransition[]) {
      provider.acknowledgements += 1;
      if (provider.acknowledgementFails) throw new Error("fixture acknowledgement failed");
      const ids = new Set(transitions.map((transition) => transition.leaseId));
      for (let index = cleanupTransitions.length - 1; index >= 0; index -= 1) if (ids.has(cleanupTransitions[index]!.leaseId)) cleanupTransitions.splice(index, 1);
    },
  };
  return provider;
}

function boundedAccess(root: string, label: string) {
  return Array.from({ length: 132 }, (_, index) => ({
    canonicalPath: join(root, `bounded-${label}-${index}-${"x".repeat(3_950)}`),
    mode: "write" as const,
  }));
}

function capacityTransition(
  providerId: string,
  leaseId: string,
  cleanedAt: string,
  access: ReturnType<typeof boundedAccess>,
): import("../src/execution-isolation-provider.js").ExecutionIsolationCleanupTransition {
  return {
    status: "cleaned", runId: "run", invocationId: `${leaseId}-invocation`, grantId: `${leaseId}-grant`, leaseId,
    providerId, implementationDigest: registeredImplementationDigest(providerId), access, cleanupToken: `${leaseId}-cleanup`, cleanedAt,
  };
}

function registeredImplementationDigest(providerId: string): string {
  return createHash("sha256").update(`${providerId}\0${"a".repeat(64)}\0${"b".repeat(64)}`).digest("hex");
}

function activeProjectionRecord(index: number) {
  return {
    occurredAt: "2026-08-27T10:00:00.000Z", runId: `old-run-${index}`, invocationId: `old-invocation-${index}`,
    grantId: `old-grant-${index}`, status: "active" as const, enforcement: "write_confinement_exact_grant" as const,
    disclosure: "provider_specific_not_universal_boundary" as const, providerId: "old-provider",
    implementationDigest: "a".repeat(64), leaseId: `old-lease-${index}`, access: [],
  };
}

async function isolationFixture(permissionProfile: "project" | "full" = "project") {
  const root = await mkdtemp(join(tmpdir(), "runner-isolation-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const authority = createExecutionGrantAuthority({
    clock: () => new Date("2026-08-28T10:00:00.000Z"),
  });
  const binding = {
    runId: "run",
    sessionId: "session",
    actor: { role: "worker" as const, id: "worker" },
    toolName: "process.run",
    callId: "call",
    permissionProfile,
  };
  const grant = await authority.issue({
    ...binding,
    workspacePath: workspace,
    access: [{ path: workspace, mode: "write" }],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  });
  return {
    root,
    authority,
    grant,
    binding,
    intent: {
      invocationId: "invocation",
      runId: "run",
      taskId: "task",
      sessionId: "session",
      kind: "command" as const,
      executable: "node",
      arguments: ["script.mjs"],
      workingDirectory: workspace,
      requestedCapabilities: ["write_confinement" as const],
    },
    claims: authority.consume(grant, binding),
    selectorOptions: { clock: () => new Date("2026-08-28T10:00:00.000Z") },
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}
