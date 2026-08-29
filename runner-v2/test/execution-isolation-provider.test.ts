import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  ExecutionIsolationError,
  createExecutionIsolationProviderRegistration,
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
  type ExecutionIsolationProvider,
} from "../src/execution-isolation-provider.js";

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
    const selection = await selector.acquire({
      permissionProfile: "project",
      intent: fixture.intent,
      grant: fixture.claims,
    });
    await assert.rejects(
      selector.release(selection),
      (error) => error instanceof ExecutionIsolationError &&
        error.code === "isolation_revocation_failed",
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
        mechanism: "fixture",
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
