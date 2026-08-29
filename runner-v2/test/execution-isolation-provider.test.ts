import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
    assert.equal(await fixture.authority.revoke(fixture.grant, "completed"), true);
    assert.equal(provider.releases, 1);
    assert.deepEqual(first.activeLeases(), []);
    assert.deepEqual(second.activeLeases(), []);
  } finally {
    await fixture.close();
  }
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
    ]), fixture.selectorOptions);
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
} = {}): ExecutionIsolationProvider & {
  acquisitions: number;
  releases: number;
  recoveries: number;
  releaseFails: boolean;
} {
  const provider = {
    acquisitions: 0,
    releases: 0,
    recoveries: 0,
    releaseFails: mutation.releaseFails ?? false,
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
      return {
        leaseId: `lease-${request.grant.grantId}`,
        providerId: request.providerId,
        invocationId: request.intent.invocationId,
        grantId: request.grant.grantId,
        grantedAccess: request.grant.access,
        acquiredAt: "2026-08-28T10:00:00.000Z",
        state: "active" as const,
        providerIdentity: request.implementationDigest,
      };
    },
    async release() {
      provider.releases += 1;
      if (provider.releaseFails) throw new Error("fixture release failed");
    },
    async recoverOwned() {
      provider.recoveries += 1;
      return { cleaned: 1, blockers: [] };
    },
  };
  return provider;
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
