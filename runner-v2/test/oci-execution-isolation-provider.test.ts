import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  createExecutionIsolationProviderRegistration,
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
  readExecutionEnforcementState,
} from "../src/execution-isolation-provider.js";
import {
  OciExecutionIsolationError,
  createNativeOciCli,
  createOciExecutionIsolationProvider,
  type OciCliInvocation,
} from "../src/oci-execution-isolation-provider.js";

test("native OCI CLI timeout settles after bounded grace when termination never closes", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; kill: () => boolean; unref: () => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  let unrefed = false;
  child.unref = () => { unrefed = true; };
  const cli = createNativeOciCli({
    spawnProcess: (() => child) as never,
    terminationGraceMs: 10,
  });
  const started = Date.now();
  await assert.rejects(
    cli.run({ executable: "fixture", args: [], environment: {}, timeoutMs: 10 }),
    (error) => error instanceof OciExecutionIsolationError && error.code === "oci_attestation_failed",
  );
  assert.ok(Date.now() - started < 200);
  assert.equal(unrefed, true);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.destroyed, true);
});

test("OCI provider attests explicit identities and creates exact labelled mounts with network denied", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-fixture",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      allowNetwork: true,
      stateDirectory: fixture.state,
      cli: fakeCli(calls),
    });
    const attestation = await provider.attest() as {
      verified: boolean;
      mechanism: string;
      exactGrantWriteConfinement: boolean;
    };
    assert.equal(attestation.verified, true);
    assert.equal(attestation.mechanism, "docker-compatible-oci");
    assert.equal(attestation.exactGrantWriteConfinement, true);

    const lease = await provider.acquire({
      providerId: "oci-fixture",
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
    }) as { leaseId: string; grantedAccess: unknown };
    assert.match(lease.leaseId, /^oci-lease-/);
    assert.deepEqual(lease.grantedAccess, fixture.claims.access);

    const create = calls.find((call) => call.args[0] === "create");
    assert.ok(create);
    assert.equal(create.executable, fixture.cli);
    assert.deepEqual(create.environment, {});
    assert.equal(create.args.includes("--privileged"), false);
    assert.equal(create.args.includes("--pid=host"), false);
    assert.equal(create.args.includes("/var/run/docker.sock"), false);
    assert.deepEqual(optionValues(create.args, "--network"), ["none"]);
    assert.equal(optionValues(create.args, "--label").includes("ai-board.runner-v2.owned=true"), true);
    assert.equal(optionValues(create.args, "--label").includes("ai-board.runner-v2.provider=oci-fixture"), true);
    assert.equal(optionValues(create.args, "--label").includes("ai-board.runner-v2.run=run"), true);
    assert.equal(optionValues(create.args, "--label").includes("ai-board.runner-v2.grant=" + fixture.claims.grantId), true);
    const mounts = optionValues(create.args, "--mount");
    assert.equal(mounts.length, 2);
    assert.equal(mounts.some((value) => value.includes(`src=${fixture.workspace}`) && value.endsWith("dst=/runner/workspace")), true);
    assert.equal(mounts.some((value) => value.includes(`src=${fixture.external}`) && value.includes("dst=/runner/grants/0") && value.endsWith(",readonly")), true);
    assert.equal(create.args.includes("sha256:" + "1".repeat(64)), true);
    assert.equal(create.args.includes("/runner/workspace/scripts/build.mjs"), true);
    assert.equal(create.args.includes("/runner/grants/0/input.txt"), true);

    const launch = await provider.prepareExecution!(lease as never, fixture.intent);
    assert.equal(launch.executable, fixture.cli);
    assert.equal(launch.invocationId, fixture.intent.invocationId);
    assert.deepEqual(launch.arguments.slice(0, 2), ["start", "--attach"]);
    assert.match(launch.arguments[2]!, /^container-fixture-/);
    assert.equal(
      calls.filter((call) => call.args[0] === "image" && call.args[1] === "inspect").length >= 3,
      true,
      "launch planning re-attests the configured CLI/image identity",
    );

    await provider.release(lease as never);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("--force")), true);
    assert.deepEqual(await provider.recoverOwned(), { cleaned: 0, blockers: [], transitions: [] });
  } finally {
    await fixture.close();
  }
});

test("OCI network requires both grant and explicit provider policy", async () => {
  for (const [allowNetwork, grantNetwork, expected] of [
    [false, false, "none"],
    [true, false, "none"],
    [false, true, "none"],
    [true, true, "bridge"],
  ] as const) {
    const fixture = await ociFixture(grantNetwork);
    const calls: OciCliInvocation[] = [];
    try {
      const provider = createOciExecutionIsolationProvider({
        providerId: "oci-network",
        cliPath: fixture.cli,
        image: "fixture/image@sha256:" + "1".repeat(64),
        allowNetwork,
        stateDirectory: fixture.state,
        cli: fakeCli(calls),
      });
      await provider.attest();
      await provider.acquire({
        providerId: "oci-network",
        implementationDigest: "a".repeat(64),
        intent: fixture.intent,
        grant: fixture.claims,
      });
      const create = calls.find((call) => call.args[0] === "create")!;
      assert.deepEqual(optionValues(create.args, "--network"), [expected]);
    } finally {
      await fixture.close();
    }
  }
});

test("OCI rejects broad parents, root mounts, symlink escapes, unsafe cwd, and ungranted absolute arguments before create", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-hostile",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli: fakeCli(calls),
    });
    await provider.attest();
    const base = {
      providerId: "oci-hostile",
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
    };
    const hostile = [
      { ...base, grant: { ...fixture.claims, access: [{ canonicalPath: dirname(fixture.workspace), mode: "write" as const }] } },
      { ...base, grant: { ...fixture.claims, access: [{ canonicalPath: parse(fixture.workspace).root, mode: "read" as const }] } },
      { ...base, intent: { ...fixture.intent, workingDirectory: fixture.external } },
      { ...base, intent: { ...fixture.intent, arguments: [join(dirname(fixture.workspace), "not-granted.txt")] } },
    ];
    for (const request of hostile) {
      await assert.rejects(
        provider.acquire(request),
        (error) => error instanceof OciExecutionIsolationError &&
          error.code === "oci_grant_unrepresentable",
      );
    }
    const alias = join(fixture.workspace, "escape");
    await symlink(fixture.external, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      provider.acquire({
        ...base,
        intent: { ...fixture.intent, arguments: [join(alias, "input.txt")] },
      }),
      (error) => error instanceof OciExecutionIsolationError &&
        error.code === "oci_path_escape",
    );
    assert.equal(calls.some((call) => call.args[0] === "create"), false);
  } finally {
    await fixture.close();
  }
});

test("OCI restart recovery validates durable labelled ownership and reports unknown labelled containers", async () => {
  const fixture = await ociFixture();
  const second = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const cli = fakeCli(calls);
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-recovery",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli,
    });
    await provider.attest();
    await provider.acquire({
      providerId: "oci-recovery",
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
    });
    await provider.acquire({
      providerId: "oci-recovery", implementationDigest: "a".repeat(64),
      intent: { ...second.intent, invocationId: "invocation-2" }, grant: second.claims,
    });
    cli.setImage("container-fixture-2", `sha256:${"9".repeat(64)}`);
    cli.psOutput = "container-fixture-1\ncontainer-fixture-2\nunknown-container\n";
    const recovered = await provider.recoverOwned();
    assert.equal(recovered.cleaned, 1);
    assert.equal(recovered.blockers.length, 2);
    assert.deepEqual(recovered.transitions?.map((transition) => transition.status), ["cleaned", "blocked"]);
    assert.equal(recovered.transitions?.[1]?.immutableImageId, `sha256:${"1".repeat(64)}`);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("container-fixture-1")), true);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("container-fixture-2")), false);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("unknown-container")), false);
    const listing = calls.find((call) => call.args[0] === "ps");
    assert.ok(listing?.args.includes("--no-trunc"), "recovery must compare canonical full container ids");
    await provider.acknowledgeRecovery(recovered.transitions?.filter((transition) => transition.status === "cleaned") ?? []);
  } finally {
    await fixture.close();
    await second.close();
  }
});

test("OCI restart recovery clears a durable lease only after confirming its container is absent", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const cli = fakeCli(calls);
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-stale",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli,
    });
    await provider.attest();
    await provider.acquire({
      providerId: "oci-stale",
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
    });
    cli.removeExternally("container-fixture-1");

    const recovered = await provider.recoverOwned();

    assert.equal(recovered.cleaned, 1);
    assert.deepEqual(recovered.blockers, []);
    assert.equal(recovered.transitions?.[0]?.status, "cleaned");
    assert.equal(durableLeaseCount(fixture.state, "oci-stale"), 1);
    await assert.rejects(provider.acknowledgeRecovery([{ ...recovered.transitions![0]!, cleanupToken: "wrong-token" }]),
      /does not match its durable tombstone/i);
    assert.equal(durableLeaseCount(fixture.state, "oci-stale"), 1);
    await provider.acknowledgeRecovery(recovered.transitions ?? []);
    assert.equal(durableLeaseCount(fixture.state, "oci-stale"), 0);
    assert.equal(calls.some((call) => call.args[0] === "inspect"), true);
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
  } finally {
    await fixture.close();
  }
});

test("OCI cleanup-started recovery converges across pre-rm and post-rm crashes without repeat cleanup", async () => {
  const first = await ociFixture(); const second = await ociFixture();
  try {
    const calls: OciCliInvocation[] = []; const cli = fakeCli(calls);
    const provider = createOciExecutionIsolationProvider({ providerId: "oci-started", cliPath: first.cli, image: "fixture:latest", stateDirectory: first.state, cli });
    await provider.attest();
    await provider.acquire({ providerId: "oci-started", implementationDigest: "a".repeat(64), intent: first.intent, grant: first.claims });
    await provider.acquire({ providerId: "oci-started", implementationDigest: "a".repeat(64), intent: { ...second.intent, invocationId: "invocation-2" }, grant: second.claims });
    const statePath = join(first.state, "oci-leases-oci-started.json");
    const rows = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>[];
    for (const row of rows) row.cleanupStage = "cleanup_started";
    await writeFile(statePath, JSON.stringify(rows));
    cli.removeExternally("container-fixture-2");
    cli.psOutput = "container-fixture-1\n";
    const recovered = await provider.recoverOwned();
    assert.equal(recovered.cleaned, 2);
    const rmCount = calls.filter((call) => call.args[0] === "rm").length;
    const replayed = await provider.recoverOwned();
    assert.deepEqual(replayed.transitions, recovered.transitions);
    assert.equal(calls.filter((call) => call.args[0] === "rm").length, rmCount);
    await provider.acknowledgeRecovery(replayed.transitions ?? []);
    assert.equal(durableLeaseCount(first.state, "oci-started"), 0);
  } finally { await first.close(); await second.close(); }
});

test("overlapping OCI provider instances preserve both durable leases without orphaning", async () => {
  const first = await ociFixture();
  const second = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const cli = fakeCli(calls);
    cli.imageIds.push(...["1", "2", "3", "4"].map((digit) => `sha256:${digit.repeat(64)}`));
    const options = {
      providerId: "oci-concurrent", cliPath: first.cli, image: "fixture/image:configured",
      stateDirectory: first.state, cli,
    };
    const left = createOciExecutionIsolationProvider(options);
    const right = createOciExecutionIsolationProvider(options);
    const projectionPath = join(first.root, "enforcement.json");
    const selectorFor = (provider: ReturnType<typeof createOciExecutionIsolationProvider>) =>
      createExecutionIsolationSelector(createExecutionIsolationRegistry([
        createExecutionIsolationProviderRegistration({
          stableProviderId: "oci-concurrent", codeDigest: "a".repeat(64), configDigest: "b".repeat(64), provider,
        }),
      ]), { ...first.selectorOptions, statePath: projectionPath });
    const leftSelector = selectorFor(left);
    const rightSelector = selectorFor(right);
    const [leftSelection, rightSelection] = await Promise.all([
      leftSelector.acquire({ permissionProfile: "project", intent: first.intent, grant: first.claims }),
      rightSelector.acquire({ permissionProfile: "project", intent: { ...second.intent, invocationId: "invocation-2" }, grant: second.claims }),
    ]);
    assert.equal(leftSelection.enforcement, "write_confinement_exact_grant");
    assert.equal(rightSelection.enforcement, "write_confinement_exact_grant");
    if (leftSelection.enforcement !== "write_confinement_exact_grant" || rightSelection.enforcement !== "write_confinement_exact_grant") throw new Error("strict OCI fixture bypassed");
    assert.equal(durableLeaseCount(first.state, "oci-concurrent"), 2);
    assert.equal(calls.filter((call) => call.args[0] === "create").length, 2);
    const usedImages = calls.filter((call) => call.args[0] === "create")
      .flatMap((call) => call.args.filter((argument) => /^sha256:/.test(argument))).sort();
    assert.deepEqual(usedImages, [`sha256:${"3".repeat(64)}`, `sha256:${"4".repeat(64)}`]);
    assert.deepEqual(durableLeaseImages(first.state, "oci-concurrent"), usedImages);
    const projected = await readExecutionEnforcementState(projectionPath);
    assert.deepEqual(projected.records.filter((record) => record.status === "active").map((record) => record.immutableImageId).sort(), usedImages);
    await Promise.all([leftSelector.release(leftSelection), rightSelector.release(rightSelection)]);
    assert.equal(durableLeaseCount(first.state, "oci-concurrent"), 0);
  } finally {
    await first.close();
    await second.close();
  }
});

test("OCI durable lease ingestion rejects forged or oversized state before any CLI action", async () => {
  const first = await ociFixture();
  const second = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-ingest", cliPath: first.cli, image: "fixture:latest", stateDirectory: first.state, cli: fakeCli(calls),
    });
    await provider.attest();
    const lease = await provider.acquire({ providerId: "oci-ingest", implementationDigest: "a".repeat(64), intent: first.intent, grant: first.claims });
    const statePath = join(first.state, "oci-leases-oci-ingest.json");
    const validText = readFileSync(statePath, "utf8");
    const valid = JSON.parse(validText) as Record<string, unknown>[];
    const leaseObject = valid[0]!.lease as { grantedAccess: Record<string, unknown>[]; immutableImageId: string };
    const forged = [
      [{ ...valid[0], unknown: true }],
      [{ ...valid[0], lease: { ...(valid[0]!.lease as object), immutableImageId: "sha256:bad" } }],
      [{ ...valid[0], lease: { ...(valid[0]!.lease as object), grantedAccess: [{ canonicalPath: "relative", mode: "write" }] } }],
      [{ ...valid[0], lease: { ...(valid[0]!.lease as object), grantedAccess: [leaseObject.grantedAccess[0], leaseObject.grantedAccess[0]] } }],
      [{ ...valid[0], runId: "forged-label-identity" }],
      [valid[0], valid[0]],
    ];
    for (const value of forged) {
      const text = JSON.stringify(value);
      await writeFile(statePath, text);
      const before = calls.length;
      await assert.rejects(provider.recoverOwned(), (error) =>
        error instanceof OciExecutionIsolationError && error.code === "oci_recovery_blocked");
      assert.equal(calls.length, before);
      assert.equal(readFileSync(statePath, "utf8"), text);
    }
    await writeFile(statePath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const before = calls.length;
    await assert.rejects(provider.release(lease as never), /durable lease state is unreadable/i);
    await assert.rejects(provider.acquire({
      providerId: "oci-ingest", implementationDigest: "a".repeat(64),
      intent: { ...second.intent, invocationId: "invocation-2" }, grant: second.claims,
    }), /durable lease state is unreadable/i);
    assert.equal(calls.length, before, "invalid durable state must trigger no inspect, rm, image, or create CLI action");
  } finally { await first.close(); await second.close(); }
});

test("OCI durable lease capacity refuses before create and bounds post-create persistence", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const providerId = "oci-capacity";
    const provider = createOciExecutionIsolationProvider({ providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli: fakeCli(calls) });
    await provider.attest();
    const statePath = join(fixture.state, `oci-leases-${providerId}.json`);
    const row = (index: number, padding = "") => {
      const leaseId = `lease-${index}`; const runId = `run-${index}-${padding}`; const invocationId = `inv-${index}`;
      return {
        lease: { leaseId, providerId, invocationId, grantId: `grant-${index}`, grantedAccess: fixture.claims.access,
          acquiredAt: "2026-08-28T10:00:00.000Z", state: "active", providerIdentity: "a".repeat(64), immutableImageId: `sha256:${"1".repeat(64)}` },
        containerId: `container-${index}`, containerName: `aiboard-${createHash("sha256").update(`${providerId}\0${runId}\0${invocationId}\0${leaseId}`).digest("hex").slice(0, 32)}`, runId,
      };
    };
    const rows = Array.from({ length: 999 }, (_, index) => row(index));
    await writeFile(statePath, JSON.stringify(rows));
    const request = { providerId, implementationDigest: "a".repeat(64), intent: fixture.intent, grant: fixture.claims };
    await provider.acquire(request);
    assert.equal((JSON.parse(readFileSync(statePath, "utf8")) as unknown[]).length, 1_000);
    const atCapacity = readFileSync(statePath, "utf8");
    const beforeCapacity = calls.length;
    await assert.rejects(provider.acquire(request), /capacity is exhausted/i);
    assert.equal(calls.length, beforeCapacity);
    assert.equal(readFileSync(statePath, "utf8"), atCapacity);

    let padded = rows;
    let selectedWidth = 0;
    for (let width = 1; width <= 512; width += 1) {
      const candidate = Array.from({ length: 999 }, (_, index) => row(index, "x".repeat(width)));
      const bytes = Buffer.byteLength(JSON.stringify(candidate));
      if (bytes < 1024 * 1024) { padded = candidate; selectedWidth = width; }
      else break;
    }
    const appendedBytes = () => Buffer.byteLength(JSON.stringify([...padded, row(2_000)]));
    if (appendedBytes() <= 1024 * 1024) {
      const extra = 1024 * 1024 - appendedBytes() + 1;
      padded[0] = row(0, "x".repeat(selectedWidth + extra));
    }
    const paddedText = JSON.stringify(padded);
    assert.ok(Buffer.byteLength(paddedText) < 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify([...padded, row(2_000)])) > 1024 * 1024);
    await writeFile(statePath, paddedText);
    const creates = calls.filter((call) => call.args[0] === "create").length;
    await assert.rejects(provider.acquire(request), (error) => error instanceof AggregateError &&
      error.errors.some((item) => item instanceof Error && /byte bound/i.test(item.message)));
    assert.equal(calls.filter((call) => call.args[0] === "create").length, creates + 1);
    assert.equal(calls.filter((call) => call.args[0] === "rm").length >= 1, true);
    assert.equal(readFileSync(statePath, "utf8"), paddedText);

    const malformed = JSON.stringify([{ ...row(0), lease: { ...row(0).lease, expiresAt: "not-a-time" } }]);
    await writeFile(statePath, malformed);
    const beforeExpiry = calls.length;
    await assert.rejects(provider.recoverOwned(), /durable lease state is unreadable/i);
    assert.equal(calls.length, beforeExpiry);
    assert.equal(readFileSync(statePath, "utf8"), malformed);
  } finally { await fixture.close(); }
});

test("real Docker fixture denies outside writes, symlink escalation, network, and cleans a live child", async (t) => {
  const docker = availableDockerFixture();
  if (!docker) {
    t.skip("Docker-compatible CLI/daemon or pre-existing alpine:latest image is unavailable; no installation or pull attempted.");
    return;
  }
  const fixture = await ociFixture();
  const trackedContainers = new Set<string>();
  try {
    const deniedOutside = join(fixture.external, "outside-write");
    const networkSentinel = join(fixture.workspace, "network-available");
    const insideSentinel = join(fixture.workspace, "inside-write");
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-real",
      cliPath: docker,
      image: "alpine:latest",
      stateDirectory: fixture.state,
    });
    await provider.attest();
    const intent = {
      ...fixture.intent,
      executable: "sh",
      arguments: ["-c", [
        "touch /runner/workspace/inside-write",
        "touch /runner/grants/0/outside-write >/dev/null 2>&1 || true",
        "ln -s /runner/grants/0 /runner/workspace/external-link",
        "touch /runner/workspace/external-link/symlink-write >/dev/null 2>&1 || true",
        "wget -q -T 2 -O /dev/null http://1.1.1.1 && touch /runner/workspace/network-available || true",
      ].join("; ")],
    };
    await provider.acquire({
      providerId: "oci-real",
      implementationDigest: "a".repeat(64),
      intent,
      grant: fixture.claims,
    });
    const containerId = durableContainerId(fixture.state, "oci-real");
    const acquiredImageId = durableLeaseImages(fixture.state, "oci-real")[0];
    trackedContainers.add(containerId);
    const start = await execFileResult(docker, ["start", "--attach", containerId]);
    assert.equal(start.code, 0, start.stderr);
    assert.equal(existsSync(insideSentinel), true);
    assert.equal(existsSync(deniedOutside), false);
    assert.equal(existsSync(join(fixture.external, "symlink-write")), false);
    assert.equal(existsSync(networkSentinel), false);
    const restartedProvider = createOciExecutionIsolationProvider({
      providerId: "oci-real", cliPath: docker, image: "alpine:latest", stateDirectory: fixture.state,
    });
    await restartedProvider.attest();
    const restartRecovery = await restartedProvider.recoverOwned();
    assert.equal(restartRecovery.cleaned, 1);
    assert.deepEqual(restartRecovery.blockers, []);
    assert.equal(restartRecovery.transitions?.[0]?.immutableImageId, acquiredImageId);
    trackedContainers.delete(containerId);
    assert.equal((await execFileResult(docker, ["inspect", containerId])).code, 1);
    assert.equal(durableLeaseCount(fixture.state, "oci-real"), 1);
    const replayedProvider = createOciExecutionIsolationProvider({
      providerId: "oci-real", cliPath: docker, image: "alpine:latest", stateDirectory: fixture.state,
    });
    await replayedProvider.attest();
    const replayed = await replayedProvider.recoverOwned();
    assert.deepEqual(replayed.transitions, restartRecovery.transitions, "pending cleanup evidence must replay identically after restart");
    await replayedProvider.acknowledgeRecovery(replayed.transitions ?? []);
    assert.equal(durableLeaseCount(fixture.state, "oci-real"), 0);
    assert.equal((await execFileResult(docker, ["ps", "-aq", "--filter", "label=ai-board.runner-v2.provider=oci-real"])).stdout.trim(), "");

    const liveFixture = await ociFixture();
    try {
      const liveProvider = createOciExecutionIsolationProvider({
        providerId: "oci-real-live",
        cliPath: docker,
        image: "alpine:latest",
        stateDirectory: liveFixture.state,
      });
      await liveProvider.attest();
      const liveLease = await liveProvider.acquire({
        providerId: "oci-real-live",
        implementationDigest: "b".repeat(64),
        intent: {
          ...liveFixture.intent,
          executable: "sh",
          arguments: ["-c", "sleep 300 & wait"],
        },
        grant: liveFixture.claims,
      });
      const liveId = durableContainerId(liveFixture.state, "oci-real-live");
      trackedContainers.add(liveId);
      assert.equal((await execFileResult(docker, ["start", liveId])).code, 0);
      await liveProvider.release(liveLease as never);
      trackedContainers.delete(liveId);
      assert.equal((await execFileResult(docker, ["inspect", liveId])).code, 1);
    } finally {
      await liveFixture.close();
    }
  } finally {
    for (const containerId of trackedContainers) {
      await execFileResult(docker, ["rm", "--force", containerId]);
    }
    await fixture.close();
  }
});

test("real Docker fixture force-cleans a labelled live child after a forced assertion path", async (t) => {
  const docker = availableDockerFixture();
  if (!docker) return t.skip("Docker unavailable; no installation attempted.");
  const fixture = await ociFixture();
  let containerId: string | undefined;
  try {
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-real-forced-cleanup", cliPath: docker, image: "alpine:latest", stateDirectory: fixture.state,
    });
    await provider.attest();
    await provider.acquire({
      providerId: "oci-real-forced-cleanup", implementationDigest: "c".repeat(64),
      intent: { ...fixture.intent, executable: "sh", arguments: ["-c", "sleep 300 & wait"] },
      grant: fixture.claims,
    });
    containerId = durableContainerId(fixture.state, "oci-real-forced-cleanup");
    assert.equal((await execFileResult(docker, ["start", containerId])).code, 0);
    await assert.rejects(async () => { throw new Error("forced fixture assertion path"); }, /forced fixture/);
  } finally {
    if (containerId) await execFileResult(docker, ["rm", "--force", containerId]);
    await fixture.close();
  }
  assert.equal((await execFileResult(docker, ["inspect", containerId!])).code, 1);
});

test("real Docker launch plan runs the original command only inside the owned container with scrubbed environment", async (t) => {
  const docker = availableDockerFixture();
  if (!docker) return t.skip("Docker unavailable; no installation attempted.");
  const fixture = await ociFixture();
  let containerId: string | undefined;
  try {
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-real-launch-plan",
      cliPath: docker,
      image: "alpine:latest",
      stateDirectory: fixture.state,
    });
    await provider.attest();
    const intent = {
      ...fixture.intent,
      executable: "sh",
      arguments: ["-c", "printf '%s' \"$SAFE_EXPLICIT\""],
    };
    const lease = await provider.acquire({
      providerId: "oci-real-launch-plan",
      implementationDigest: "e".repeat(64),
      intent,
      grant: fixture.claims,
      environment: { SAFE_EXPLICIT: "approved-inside-container" },
    });
    containerId = durableContainerId(fixture.state, "oci-real-launch-plan");
    const plan = await provider.prepareExecution!(lease as never, intent);
    assert.equal(plan.executable, docker);
    assert.deepEqual(plan.arguments, ["start", "--attach", containerId]);
    assert.equal(JSON.stringify(plan).includes("approved-inside-container"), false);
    assert.equal(readFileSync(join(fixture.state, "oci-leases-oci-real-launch-plan.json"), "utf8").includes("approved-inside-container"), false);
    const result = await execFileResult(plan.executable, [...plan.arguments]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "approved-inside-container");
    await provider.release(lease as never);
    containerId = undefined;
  } finally {
    if (containerId) await execFileResult(docker, ["rm", "--force", containerId]);
    await fixture.close();
  }
});

test("real Docker recovery blocks an exact image mismatch without removing the container", async (t) => {
  const docker = availableDockerFixture();
  if (!docker) return t.skip("Docker unavailable; no installation attempted.");
  const fixture = await ociFixture();
  let containerId: string | undefined;
  try {
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-real-mismatch", cliPath: docker, image: "alpine:latest", stateDirectory: fixture.state,
    });
    await provider.attest();
    await provider.acquire({ providerId: "oci-real-mismatch", implementationDigest: "d".repeat(64), intent: fixture.intent, grant: fixture.claims });
    containerId = durableContainerId(fixture.state, "oci-real-mismatch");
    const statePath = join(fixture.state, "oci-leases-oci-real-mismatch.json");
    const rows = JSON.parse(readFileSync(statePath, "utf8")) as { lease: { immutableImageId: string } }[];
    rows[0]!.lease.immutableImageId = `sha256:${"0".repeat(64)}`;
    await writeFile(statePath, JSON.stringify(rows));
    const restarted = createOciExecutionIsolationProvider({
      providerId: "oci-real-mismatch", cliPath: docker, image: "alpine:latest", stateDirectory: fixture.state,
    });
    await restarted.attest();
    const recovered = await restarted.recoverOwned();
    assert.equal(recovered.cleaned, 0);
    assert.equal(recovered.blockers.length, 1);
    assert.equal(recovered.transitions?.[0]?.status, "blocked");
    assert.equal((await execFileResult(docker, ["inspect", containerId])).code, 0);
  } finally {
    if (containerId) await execFileResult(docker, ["rm", "--force", containerId]);
    await fixture.close();
  }
});

function fakeCli(calls: OciCliInvocation[]) {
  const labelsByContainer = new Map<string, Record<string, string>>();
  const imageByContainer = new Map<string, string>();
  let createdCount = 0;
  const runner = {
    psOutput: "",
    imageIds: [] as string[],
    setImage(containerId: string, imageId: string) { imageByContainer.set(containerId, imageId); },
    removeExternally(containerId: string) {
      labelsByContainer.delete(containerId);
      imageByContainer.delete(containerId);
    },
    async run(invocation: OciCliInvocation) {
      calls.push(structuredClone(invocation));
      const [command] = invocation.args;
      if (command === "image") {
        return { exitCode: 0, stdout: (runner.imageIds.shift() ?? "sha256:" + "1".repeat(64)) + "\n", stderr: "" };
      }
      if (command === "create") {
        createdCount += 1;
        const containerId = `container-fixture-${createdCount}`;
        labelsByContainer.set(containerId, Object.fromEntries(
          optionValues(invocation.args, "--label").map((label) => {
            const separator = label.indexOf("=");
            return [label.slice(0, separator), label.slice(separator + 1)];
          }),
        ));
        imageByContainer.set(containerId, invocation.args.find((argument) => /^sha256:[a-f0-9]{64}$/.test(argument))!);
        return { exitCode: 0, stdout: `${containerId}\n`, stderr: "" };
      }
      if (command === "ps") {
        return { exitCode: 0, stdout: runner.psOutput, stderr: "" };
      }
      if (command === "inspect") {
        if (invocation.args.includes("{{.Image}}")) {
          const image = imageByContainer.get(invocation.args.at(-1)!);
          return image ? { exitCode: 0, stdout: `${image}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "not found" };
        }
        const labels = labelsByContainer.get(invocation.args.at(-1)!);
        if (!labels) return { exitCode: 1, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          stdout: JSON.stringify(labels) + "\n",
          stderr: "",
        };
      }
      if (command === "rm") {
        labelsByContainer.delete(invocation.args.at(-1)!);
        imageByContainer.delete(invocation.args.at(-1)!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected fake command" };
    },
  };
  return runner;
}

async function ociFixture(networkApproved = false) {
  const root = await mkdtemp(join(tmpdir(), "runner-oci-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const external = join(root, "external");
  const cli = join(root, process.platform === "win32" ? "docker.exe" : "docker");
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await mkdir(external);
  await mkdir(state);
  await writeFile(cli, "fixture docker-compatible cli");
  await writeFile(join(workspace, "scripts", "build.mjs"), "");
  await writeFile(join(external, "input.txt"), "fixture");
  const authority = createExecutionGrantAuthority({
    clock: () => new Date("2026-08-28T10:00:00.000Z"),
  });
  const binding = {
    runId: "run",
    sessionId: "session",
    actor: { role: "worker" as const, id: "worker" },
    toolName: "process.run",
    callId: "call",
    permissionProfile: "project" as const,
  };
  const grant = await authority.issue({
    ...binding,
    workspacePath: workspace,
    access: [
      { path: workspace, mode: "write" },
      { path: external, mode: "read" },
    ],
    externalApproved: true,
    destructiveApproved: false,
    networkApproved,
  });
  return {
    root,
    workspace,
    external,
    state,
    cli,
    selectorOptions: { clock: () => new Date("2026-08-28T10:00:00.000Z") },
    claims: authority.consume(grant, binding),
    intent: {
      invocationId: "invocation",
      runId: "run",
      taskId: "task",
      sessionId: "session",
      kind: "command" as const,
      executable: "node",
      arguments: [
        join(workspace, "scripts", "build.mjs"),
        join(external, "input.txt"),
      ],
      workingDirectory: workspace,
      requestedCapabilities: ["write_confinement" as const],
    },
    close: async () => await rm(root, { recursive: true, force: true }),
  };
}

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) values.push(args[index + 1]!);
  }
  return values;
}

function availableDockerFixture(): string | undefined {
  try {
    const explicit = process.env.RUNNER_V2_TEST_DOCKER_CLI;
    const executable = explicit || (process.platform === "win32"
      ? execFileSync("where.exe", ["docker"], { encoding: "utf8" }).split(/\r?\n/)[0]
      : execFileSync("which", ["docker"], { encoding: "utf8" }).trim());
    if (!executable || !isAbsolute(executable)) return undefined;
    execFileSync(executable, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    execFileSync(executable, ["image", "inspect", "alpine:latest"], { stdio: "ignore" });
    return executable;
  } catch {
    return undefined;
  }
}

function durableContainerId(state: string, providerId: string): string {
  const rows = JSON.parse(readFileSync(join(state, `oci-leases-${providerId}.json`), "utf8")) as {
    containerId: string;
  }[];
  assert.equal(rows.length, 1);
  return rows[0]!.containerId;
}

function durableLeaseCount(state: string, providerId: string): number {
  const rows = JSON.parse(readFileSync(join(state, `oci-leases-${providerId}.json`), "utf8")) as unknown[];
  return rows.length;
}

function durableLeaseImages(state: string, providerId: string): string[] {
  const rows = JSON.parse(readFileSync(join(state, `oci-leases-${providerId}.json`), "utf8")) as {
    lease: { immutableImageId?: string };
  }[];
  return rows.map((row) => row.lease.immutableImageId!).sort();
}

async function execFileResult(executable: string, args: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolvePromise) => {
    execFile(executable, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      resolvePromise({
        code: typeof (error as NodeJS.ErrnoException | null)?.code === "number"
          ? (error as unknown as { code: number }).code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}
