import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  ExecutionIsolationError,
  createExecutionIsolationProviderRegistration,
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
  readExecutionEnforcementState,
} from "../src/execution-isolation-provider.js";
import {
  OciExecutionIsolationError,
  createNativeOciCli,
  createOciExecutionIsolationProvider,
  type OciCli,
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
      lifecycle: { scope: string; termination: string; emptiness: string };
    };
    assert.equal(attestation.verified, true);
    assert.equal(attestation.mechanism, "docker-compatible-oci");
    assert.equal(attestation.exactGrantWriteConfinement, true);
    assert.deepEqual(attestation.lifecycle, { scope: "contained_workload", termination: "enforced", emptiness: "enforced" });

    const lease = await provider.acquire({
      providerId: "oci-fixture",
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
    }) as { leaseId: string; grantedAccess: unknown };
    assert.match(lease.leaseId, /^oci-lease-/);
    assert.deepEqual(lease.grantedAccess, fixture.claims.access);

    const create = workloadCreates(calls)[0];
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
    assert.equal(launch.requiredLifecycleScope, "process_group");
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

test("host attach completion leaves the container lease until isolation.release", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const cli = fakeCli(calls);
    const providerId = "oci-attach-lease";
    const provider = createOciExecutionIsolationProvider({
      providerId,
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli,
    });
    await provider.attest();
    const lease = await provider.acquire({
      providerId,
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
    });
    const launch = await provider.prepareExecution!(lease as never, fixture.intent);
    assert.equal(launch.requiredLifecycleScope, "process_group");
    assert.equal(launch.executable, fixture.cli);
    assert.deepEqual(launch.arguments.slice(0, 2), ["start", "--attach"]);
    const attach = await cli.run({
      executable: launch.executable,
      args: launch.arguments,
      environment: {},
      timeoutMs: 5_000,
    });
    assert.equal(attach.exitCode, 0, attach.stderr);
    assert.equal(durableLeaseCount(fixture.state, providerId), 1);
    assert.equal(workloadRemoves(calls).length, 0);
    await provider.release(lease as never);
    assert.equal(workloadRemoves(calls).length, 1);
    assert.equal(workloadRemoves(calls)[0]!.args.includes("--force"), true);
    assert.equal(durableLeaseCount(fixture.state, providerId), 0);
  } finally {
    await fixture.close();
  }
});

test("strict OCI duplex requires separately attested interactive create and exact interactive attach", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-interactive",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli: fakeCli(calls, { interactiveAttach: true, imageExecutables: ["sh"] }),
    });
    const attestation = await provider.attest() as { interactiveAttach?: boolean };
    assert.equal(attestation.interactiveAttach, true);
    const intent = {
      ...fixture.intent,
      kind: "mcp_server" as const,
      executable: "sh",
      arguments: [],
    };
    const lease = await provider.acquire({
      providerId: "oci-interactive",
      implementationDigest: "a".repeat(64),
      intent,
      grant: fixture.claims,
    });
    const create = workloadCreates(calls)[0];
    assert.ok(create);
    assert.equal(create.args.includes("--interactive"), true);
    const plan = await provider.prepareExecution!(lease as never, intent);
    assert.deepEqual(plan.arguments, ["start", "--attach", "--interactive", durableContainerId(fixture.state, "oci-interactive")]);
    await provider.release(lease as never);
  } finally {
    await fixture.close();
  }
});

test("strict OCI consumer cancellation and external disappearance retain exact cleanup ownership", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const cli = fakeCli(calls, { interactiveAttach: true, imageExecutables: ["sh"] });
    const providerId = "oci-interactive-lifecycle";
    const provider = createOciExecutionIsolationProvider({
      providerId,
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli,
    });
    await provider.attest();
    const intent = {
      ...fixture.intent,
      kind: "mcp_server" as const,
      executable: "sh",
      arguments: ["-c", "while :; do sleep 1; done"],
    };
    const cancelledLease = await provider.acquire({
      providerId,
      implementationDigest: "a".repeat(64),
      intent,
      grant: fixture.claims,
    });
    const cancelledPlan = await provider.prepareExecution!(cancelledLease as never, intent);
    const cancellation = new AbortController();
    cancellation.abort();
    assert.equal(cancellation.signal.aborted, true);
    assert.equal(cancelledPlan.executable, fixture.cli);
    assert.deepEqual(cancelledPlan.arguments, [
      "start", "--attach", "--interactive", durableContainerId(fixture.state, providerId),
    ]);
    await provider.release(cancelledLease as never);
    assert.equal(durableLeaseCount(fixture.state, providerId), 0);

    const disappearedIntent = { ...intent, invocationId: "invocation-disappeared" };
    await provider.acquire({
      providerId,
      implementationDigest: "a".repeat(64),
      intent: disappearedIntent,
      grant: fixture.claims,
    });
    const disappearedId = durableContainerId(fixture.state, providerId);
    cli.removeExternally(disappearedId);
    const restarted = createOciExecutionIsolationProvider({
      providerId,
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli,
    });
    await restarted.attest();
    const recovered = await restarted.recoverOwned();
    assert.equal(recovered.cleaned, 1);
    assert.deepEqual(recovered.blockers, []);
    assert.equal(recovered.transitions?.[0]?.status, "cleaned");
    await restarted.acknowledgeRecovery(recovered.transitions ?? []);
    assert.equal(durableLeaseCount(fixture.state, providerId), 0);
    assert.equal(workloadCreates(calls).every((call) => call.args.includes("--interactive")), true);
    assert.equal(workloadCreates(calls).some((call) =>
      optionValues(call.args, "--mount").some((mount) => mount.includes(`src=${fixture.cli}`))), false);
  } finally {
    await fixture.close();
  }
});

test("strict OCI duplex fails typed before executable probing or create when interactive attach is unavailable", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-no-interactive",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli: fakeCli(calls, { interactiveAttach: false, imageExecutables: ["sh"] }),
    });
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({
        stableProviderId: "oci-no-interactive",
        codeDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        provider,
      }),
    ]), fixture.selectorOptions);
    await assert.rejects(
      selector.acquire({
        permissionProfile: "project",
        intent: { ...fixture.intent, kind: "mcp_server", executable: "sh", arguments: [] },
        grant: fixture.claims,
      }),
      (error) => error instanceof ExecutionIsolationError && error.code === "isolation_capability_unavailable",
    );
    assert.equal(calls.some((call) => call.args[0] === "run"), false);
    assert.equal(workloadCreates(calls).length, 0);
  } finally {
    await fixture.close();
  }
});

test("strict OCI rejects a bind-mounted host executable before workload creation", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-host-executable",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli: fakeCli(calls),
    });
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({
        stableProviderId: "oci-host-executable",
        codeDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        provider,
      }),
    ]), fixture.selectorOptions);
    await assert.rejects(
      selector.acquire({
        permissionProfile: "project",
        intent: {
          ...fixture.intent,
          executable: join(fixture.workspace, "scripts", "build.mjs"),
          arguments: [],
        },
        grant: fixture.claims,
      }),
      (error) => error instanceof ExecutionIsolationError && error.code === "isolation_capability_unavailable",
    );
    assert.equal(calls.some((call) => call.args[0] === "create" &&
      !optionValues(call.args, "--label").includes("ai-board.runner-v2.probe=true")), false);
  } finally {
    await fixture.close();
  }
});

test("strict OCI interactive capability requires a semantic create/start duplex round trip", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-false-help-advertisement",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli: fakeCli(calls, { interactiveAttach: true, semanticDuplex: false }),
    });
    const attestation = await provider.attest() as { interactiveAttach?: boolean };
    assert.equal(attestation.interactiveAttach, false);
    assert.equal(calls.some((call) => call.args[0] === "help"), false,
      "syntax advertising is not capability evidence");
    assert.equal(calls.some((call) => call.args[0] === "create" &&
      optionValues(call.args, "--label").includes("ai-board.runner-v2.probe=true")), true);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("--force")), true);
  } finally {
    await fixture.close();
  }
});

test("strict OCI duplex fails typed before create when its executable is absent from the immutable image", async () => {
  const fixture = await ociFixture();
  try {
    const calls: OciCliInvocation[] = [];
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-missing-image-executable",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli: fakeCli(calls, { interactiveAttach: true, imageExecutables: [] }),
    });
    const selector = createExecutionIsolationSelector(createExecutionIsolationRegistry([
      createExecutionIsolationProviderRegistration({
        stableProviderId: "oci-missing-image-executable",
        codeDigest: "a".repeat(64),
        configDigest: "b".repeat(64),
        provider,
      }),
    ]), fixture.selectorOptions);
    await assert.rejects(
      selector.acquire({
        permissionProfile: "project",
        intent: { ...fixture.intent, kind: "language_server", executable: "missing-lsp", arguments: [] },
        grant: fixture.claims,
      }),
      (error) => error instanceof ExecutionIsolationError && error.code === "isolation_capability_unavailable",
    );
    assert.equal(calls.filter((call) => call.args[0] === "run").length, 1);
    assert.equal(workloadCreates(calls).length, 0);
  } finally {
    await fixture.close();
  }
});

for (const pathName of ["PATH", "Path", "path"] as const) {
  test(`OCI preserves the attested image search path instead of inheriting host ${pathName}`, async () => {
    const fixture = await ociFixture();
    const calls: OciCliInvocation[] = [];
    const cli = fakeCli(calls);
    const provider = createOciExecutionIsolationProvider({ providerId: "oci-image-search-path", cliPath: fixture.cli,
      image: "fixture/image:configured", stateDirectory: fixture.state, cli });
    try {
      await provider.attest();
      const environment = { [pathName]: "C:\\HostOnly\\bin;C:\\Windows\\System32", APPROVED_DATA: "child-only-value" };
      const lease = await provider.acquire({ providerId: "oci-image-search-path", implementationDigest: "a".repeat(64),
        intent: fixture.intent, grant: fixture.claims, environment });
      try {
        assert.deepEqual(cli.environmentFiles, [{ APPROVED_DATA: "child-only-value" }],
          "image-relative executable attestation must use the same image-owned PATH at execution");
        assert.equal(environment[pathName], "C:\\HostOnly\\bin;C:\\Windows\\System32", "do not mutate the caller's host environment");
        assert.equal(calls.every((call) => Object.keys(call.environment).length === 0), true,
          "neither child data nor host search paths may select the Docker control plane");
        assert.equal(cli.environmentFilePaths.every((path) => !existsSync(path)), true);
      } finally { await provider.release(lease as never); }
      assert.deepEqual(await provider.recoverOwned(), { cleaned: 0, blockers: [], transitions: [] });
    } finally { await fixture.close(); }
  });
}

test("OCI does not allocate a private environment handoff for only a host search path", async () => {
  const fixture = await ociFixture();
  const calls: OciCliInvocation[] = [];
  const cli = fakeCli(calls);
  const provider = createOciExecutionIsolationProvider({ providerId: "oci-path-only", cliPath: fixture.cli,
    image: "fixture/image:configured", stateDirectory: fixture.state, cli });
  try {
    await provider.attest();
    const lease = await provider.acquire({ providerId: "oci-path-only", implementationDigest: "a".repeat(64),
      intent: fixture.intent, grant: fixture.claims, environment: { PATH: "/host-only/bin" } });
    try {
      assert.deepEqual(cli.environmentFilePaths, []);
      assert.equal(workloadCreates(calls)[0]!.args.includes("--env-file"), false);
    } finally { await provider.release(lease as never); }
  } finally { await fixture.close(); }
});

test("OCI child environment never enters the attested Docker control-plane environment", async () => {
  const fixture = await ociFixture();
  const calls: OciCliInvocation[] = [];
  const cli = fakeCli(calls);
  try {
    const provider = createOciExecutionIsolationProvider({
      providerId: "oci-environment-handoff",
      cliPath: fixture.cli,
      image: "fixture/image:configured",
      stateDirectory: fixture.state,
      cli,
    });
    await provider.attest();
    const environment = {
      SAFE_EXPLICIT: "approved-inside-container",
      DOCKER_HOST: "tcp://attacker.invalid:2376",
      DOCKER_CONTEXT: "attacker-context",
      DOCKER_CONFIG: join(fixture.root, "attacker-config"),
      DOCKER_TLS_VERIFY: "reserved-tls-verify-secret",
      DOCKER_CERT_PATH: join(fixture.root, "attacker-certificates"),
    };
    const lease = await provider.acquire({
      providerId: "oci-environment-handoff",
      implementationDigest: "a".repeat(64),
      intent: fixture.intent,
      grant: fixture.claims,
      environment,
    });
    const create = workloadCreates(calls)[0]!;
    assert.deepEqual(create.environment, {}, "child variables must not select the Docker daemon");
    assert.equal(create.args.includes("--env-file"), true);
    for (const value of Object.values(environment)) {
      assert.equal(create.args.includes(value), false);
      assert.equal(JSON.stringify(lease).includes(value), false);
      assert.equal(readFileSync(join(fixture.state, "oci-leases-oci-environment-handoff.json"), "utf8").includes(value), false);
    }
    assert.deepEqual(cli.environmentFiles, [environment]);
    assert.equal(cli.environmentFilePaths.every((path) => !existsSync(path)), true);
    await provider.release(lease as never);
    assert.equal(calls.every((call) => Object.keys(call.environment).length === 0), true);
  } finally {
    await fixture.close();
  }
});

test("OCI deletion faults never orphan a successfully created container and recover deterministically", async (t) => {
  for (const containerCleanupFails of [false, true]) {
    await t.test(containerCleanupFails ? "handoff and compensation fail" : "handoff deletion fails", async () => {
      const fixture = await ociFixture();
      const calls: OciCliInvocation[] = [];
      const base = fakeCli(calls);
      let failHandoff = true;
      let failContainerCleanup = containerCleanupFails;
      const cli: OciCli = {
        ...base,
        run: async (invocation) => {
          if (invocation.args[0] === "rm" && failContainerCleanup &&
              !String(invocation.args.at(-1)).startsWith("probe-fixture-") &&
              !String(invocation.args.at(-1)).startsWith("aiboard-probe-")) {
            calls.push(invocation);
            return { exitCode: 1, stdout: "", stderr: "injected rm failure" };
          }
          return await base.run(invocation);
        },
      };
      const removeHandoff = async (path: string, root: string) => {
        if (failHandoff) throw new Error("injected handoff unlink failure");
        await rm(path, { force: true });
        await rmdir(root).catch(() => undefined);
      };
      try {
        const provider = createOciExecutionIsolationProvider({
          providerId: `oci-deletion-fault-${containerCleanupFails}`,
          cliPath: fixture.cli,
          image: "fixture/image:configured",
          stateDirectory: fixture.state,
          cli,
          removeEnvironmentHandoff: removeHandoff,
        });
        await provider.attest();
        await assert.rejects(provider.acquire({
          providerId: `oci-deletion-fault-${containerCleanupFails}`,
          implementationDigest: "a".repeat(64),
          intent: fixture.intent,
          grant: fixture.claims,
          environment: { APPROVED_SECRET: "private-value" },
        }), (error: unknown) => (error as { code?: unknown }).code === "oci_recovery_blocked");
        const statePath = join(fixture.state, `oci-leases-oci-deletion-fault-${containerCleanupFails}.json`);
        const durable = readFileSync(statePath, "utf8");
        assert.equal(durable.includes("container-fixture-1"), true, "created effect is durably owned");
        assert.equal(durable.includes("private-value"), false);
        assert.equal(workloadRemoves(calls).length > 0, true, "compensation is attempted");

        failHandoff = false;
        failContainerCleanup = false;
        base.psOutput = "container-fixture-1\n";
        const recovered = await provider.recoverOwned();
        assert.equal(recovered.blockers.length, 0, JSON.stringify(recovered));
        const transitions = recovered.transitions ?? [];
        assert.equal(transitions.length, 1, JSON.stringify(recovered));
        await provider.acknowledgeRecovery!(transitions);
        base.psOutput = "";
        assert.deepEqual(await provider.recoverOwned(), { cleaned: 0, blockers: [], transitions: [] });
        assert.equal(existsSync(join(fixture.state, "environment-handoffs")), false);
        assert.equal(readFileSync(statePath, "utf8"), "[]");
      } finally {
        await fixture.close();
      }
    });
  }
});

test("OCI pre-effect create journal recovers every pre-identity failure without secret or container orphan", async (t) => {
  for (const mode of ["throw", "nonzero", "invalid_id", "effect_then_throw"] as const) {
    for (const deletionFails of [false, true]) {
      await t.test(`${mode}; handoff deletion ${deletionFails ? "fails" : "succeeds"}`, async () => {
        const fixture = await ociFixture();
        const calls: OciCliInvocation[] = [];
        const base = fakeCli(calls);
        let failDeletion = deletionFails;
        const cli: OciCli = {
          ...base,
          run: async (invocation) => {
            if (invocation.args[0] !== "create" || isProbeCreate(invocation)) return await base.run(invocation);
            if (mode === "throw") {
              calls.push(structuredClone(invocation));
              throw new Error("injected create transport failure");
            }
            if (mode === "nonzero") {
              calls.push(structuredClone(invocation));
              return { exitCode: 125, stdout: "", stderr: "injected create rejection" };
            }
            const effected = await base.run(invocation);
            if (mode === "invalid_id") return { ...effected, stdout: "invalid id with spaces\n" };
            throw new Error("injected transport loss after daemon effect");
          },
        };
        const removeHandoff = async (path: string, root: string) => {
          if (failDeletion) throw new Error("injected handoff deletion failure");
          await rm(path, { force: true });
          await rmdir(root).catch(() => undefined);
        };
        const providerId = `oci-create-journal-${mode}-${deletionFails}`;
        const statePath = join(fixture.state, `oci-leases-${providerId}.json`);
        try {
          const provider = createOciExecutionIsolationProvider({
            providerId, cliPath: fixture.cli, image: "fixture/image:configured", stateDirectory: fixture.state,
            cli, removeEnvironmentHandoff: removeHandoff,
          });
          await provider.attest();
          await assert.rejects(provider.acquire({
            providerId, implementationDigest: "a".repeat(64), intent: fixture.intent, grant: fixture.claims,
            environment: { APPROVED_SECRET: "journal-private-value" },
          }));
          const durable = readFileSync(statePath, "utf8");
          assert.equal(durable.includes("journal-private-value"), false);
          assert.equal(durable.includes("aiboard-"), true, "exact owned name is journaled before create");

          failDeletion = false;
          const restarted = createOciExecutionIsolationProvider({
            providerId, cliPath: fixture.cli, image: "fixture/image:configured", stateDirectory: fixture.state,
            cli, removeEnvironmentHandoff: removeHandoff,
          });
          await restarted.attest();
          const recovered = await restarted.recoverOwned();
          assert.equal(recovered.blockers.length, 0, JSON.stringify(recovered));
          const transitions = recovered.transitions ?? [];
          assert.equal(transitions.length, 1, JSON.stringify(recovered));
          await restarted.acknowledgeRecovery!(transitions);
          assert.deepEqual(await restarted.recoverOwned(), { cleaned: 0, blockers: [], transitions: [] });
          assert.equal(readFileSync(statePath, "utf8"), "[]");
          assert.equal(existsSync(join(fixture.state, "environment-handoffs")), false);
          const effectExpected = mode === "invalid_id" || mode === "effect_then_throw";
          assert.equal(workloadRemoves(calls).length > 0, effectExpected);
        } finally { await fixture.close(); }
      });
    }
  }
});

test("OCI create journal owns absent and present handoffs across crash barriers", async (t) => {
  for (const stage of ["after_create_journal", "after_environment_handoff"] as const) {
    await t.test(stage, async () => {
      const fixture = await ociFixture();
      const calls: OciCliInvocation[] = [];
      const cli = fakeCli(calls);
      let entered!: () => void;
      let resume!: () => void;
      const enteredBarrier = new Promise<void>((resolve) => { entered = resolve; });
      const resumeBarrier = new Promise<void>((resolve) => { resume = resolve; });
      const providerId = `oci-crash-barrier-${stage}`;
      const statePath = join(fixture.state, `oci-leases-${providerId}.json`);
      let acquisition: Promise<unknown> | undefined;
      try {
        const provider = createOciExecutionIsolationProvider({
          providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli,
          acquireBarrier: async (current) => {
            if (current !== stage) return;
            entered();
            await resumeBarrier;
            throw new Error(`injected crash at ${stage}`);
          },
        });
        await provider.attest();
        acquisition = provider.acquire({
          providerId, implementationDigest: "a".repeat(64), intent: fixture.intent, grant: fixture.claims,
          environment: { APPROVED_SECRET: "crash-private-value" },
        });
        await enteredBarrier;
        const durable = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ createStage: string; environmentHandoffPath: string }>;
        assert.equal(durable[0]?.createStage, "creating");
        assert.equal(readFileSync(statePath, "utf8").includes("crash-private-value"), false);
        assert.equal(existsSync(durable[0]!.environmentHandoffPath), stage === "after_environment_handoff");
        assert.equal(workloadCreates(calls).length, 0);

        const restarted = createOciExecutionIsolationProvider({
          providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli,
        });
        await restarted.attest();
        const recovered = await restarted.recoverOwned();
        assert.deepEqual(recovered.blockers, []);
        assert.equal(recovered.transitions?.length, 1);
        await restarted.acknowledgeRecovery!(recovered.transitions ?? []);
        assert.equal(readFileSync(statePath, "utf8"), "[]");
        assert.equal(existsSync(join(fixture.state, "environment-handoffs")), false);
        resume();
        await assert.rejects(acquisition);
      } finally {
        resume();
        await acquisition?.catch(() => undefined);
        await fixture.close();
      }
    });
  }
});

test("OCI file-write plus cleanup failure retains its pre-effect journal for restart", async () => {
  const fixture = await ociFixture();
  const calls: OciCliInvocation[] = [];
  const cli = fakeCli(calls);
  const providerId = "oci-write-cleanup-fault";
  const statePath = join(fixture.state, `oci-leases-${providerId}.json`);
  try {
    const provider = createOciExecutionIsolationProvider({
      providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli,
      writeEnvironmentHandoff: async (prepared) => {
        await mkdir(prepared.root, { recursive: true });
        await writeFile(prepared.path, prepared.contents, { mode: 0o600 });
        throw new Error("injected environment handoff write failure");
      },
      removeEnvironmentHandoff: async () => { throw new Error("injected environment handoff cleanup failure"); },
    });
    await provider.attest();
    await assert.rejects(provider.acquire({
      providerId, implementationDigest: "a".repeat(64), intent: fixture.intent, grant: fixture.claims,
      environment: { APPROVED_SECRET: "write-private-value" },
    }), (error: unknown) => (error as { code?: string }).code === "oci_recovery_blocked");
    const durable = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ createStage: string; environmentHandoffPath: string }>;
    assert.equal(durable[0]?.createStage, "creating");
    assert.equal(existsSync(durable[0]!.environmentHandoffPath), true);
    assert.equal(readFileSync(statePath, "utf8").includes("write-private-value"), false);
    assert.equal(workloadCreates(calls).length, 0);

    const restarted = createOciExecutionIsolationProvider({
      providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli,
    });
    await restarted.attest();
    const recovered = await restarted.recoverOwned();
    assert.deepEqual(recovered.blockers, []);
    await restarted.acknowledgeRecovery!(recovered.transitions ?? []);
    assert.equal(readFileSync(statePath, "utf8"), "[]");
    assert.equal(existsSync(join(fixture.state, "environment-handoffs")), false);
  } finally { await fixture.close(); }
});

test("OCI re-attests returned create identity before durable binding", async (t) => {
  for (const mode of ["returned_id_mismatch", "inspect_failure"] as const) {
    await t.test(mode, async () => {
      const fixture = await ociFixture();
      const calls: OciCliInvocation[] = [];
      const base = fakeCli(calls);
      let failInspection = mode === "inspect_failure";
      const cli: OciCli = { ...base, run: async (invocation) => {
        const result = await base.run(invocation);
        if (invocation.args[0] === "create" && !isProbeCreate(invocation) && mode === "returned_id_mismatch") {
          return { ...result, stdout: "unowned-returned-id\n" };
        }
        if (failInspection && invocation.args[0] === "inspect" && invocation.args.includes("{{json .Config.Labels}}")) {
          return { exitCode: 1, stdout: "", stderr: "injected inspect failure" };
        }
        return result;
      } };
      const providerId = `oci-returned-identity-${mode}`;
      const statePath = join(fixture.state, `oci-leases-${providerId}.json`);
      try {
        const provider = createOciExecutionIsolationProvider({
          providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli,
        });
        await provider.attest();
        await assert.rejects(provider.acquire({
          providerId, implementationDigest: "a".repeat(64), intent: fixture.intent, grant: fixture.claims,
        }));
        const state = readFileSync(statePath, "utf8");
        assert.equal(state.includes("unowned-returned-id"), false);
        assert.equal(state.includes("container-fixture-1") && mode === "inspect_failure", false,
          "failed returned-ID inspection must not durably bind that identity");
        failInspection = false;
        const restarted = createOciExecutionIsolationProvider({
          providerId, cliPath: fixture.cli, image: "fixture:latest", stateDirectory: fixture.state, cli,
        });
        await restarted.attest();
        base.psOutput = "container-fixture-1\n";
        const recovered = await restarted.recoverOwned();
        assert.deepEqual(recovered.blockers, []);
        await restarted.acknowledgeRecovery!(recovered.transitions ?? []);
        assert.equal(readFileSync(statePath, "utf8"), "[]");
        assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.at(-1) === "container-fixture-1"), true);
      } finally { await fixture.close(); }
    });
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
      const create = workloadCreates(calls)[0]!;
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
    assert.equal(workloadCreates(calls).length, 0);
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
    const listing = calls.find((call) => call.args[0] === "ps" && call.args.includes("--no-trunc"));
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
    assert.equal(workloadRemoves(calls).length, 0);
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
    assert.equal(workloadCreates(calls).length, 2);
    const usedImages = workloadCreates(calls)
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
    const externalHandoffSentinel = join(second.root, "environment-11111111-1111-4111-8111-111111111111.env");
    await writeFile(externalHandoffSentinel, "must-not-delete");
    const forged = [
      [{ ...valid[0], unknown: true }],
      [{ ...valid[0], lease: { ...(valid[0]!.lease as object), immutableImageId: "sha256:bad" } }],
      [{ ...valid[0], lease: { ...(valid[0]!.lease as object), grantedAccess: [{ canonicalPath: "relative", mode: "write" }] } }],
      [{ ...valid[0], lease: { ...(valid[0]!.lease as object), grantedAccess: [leaseObject.grantedAccess[0], leaseObject.grantedAccess[0]] } }],
      [{ ...valid[0], runId: "forged-label-identity" }],
      [{ ...valid[0], environmentHandoffPath: externalHandoffSentinel }],
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
      assert.equal(readFileSync(externalHandoffSentinel, "utf8"), "must-not-delete");
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
    const creates = workloadCreates(calls).length;
    await assert.rejects(provider.acquire(request), (error) =>
      error instanceof OciExecutionIsolationError && error.code === "oci_recovery_blocked" &&
      error.cause instanceof Error && /byte bound/i.test(error.cause.message));
    assert.equal(workloadCreates(calls).length, creates,
      "pre-effect journal capacity failure must happen before create");
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
      arguments: ["-c", "printf '%s|%s|%s|%s|%s' \"$SAFE_EXPLICIT\" \"$DOCKER_HOST\" \"$DOCKER_CONTEXT\" \"$DOCKER_CONFIG\" \"$DOCKER_TLS_VERIFY\""],
    };
    const childEnvironment = {
      SAFE_EXPLICIT: "approved-inside-container",
      DOCKER_HOST: "tcp://must-not-control-cli.invalid:2376",
      DOCKER_CONTEXT: "must-not-control-cli-context",
      DOCKER_CONFIG: "/must-not-control-cli-config",
      DOCKER_TLS_VERIFY: "must-not-control-cli-tls",
    };
    const lease = await provider.acquire({
      providerId: "oci-real-launch-plan",
      implementationDigest: "e".repeat(64),
      intent,
      grant: fixture.claims,
      environment: childEnvironment,
    });
    containerId = durableContainerId(fixture.state, "oci-real-launch-plan");
    const plan = await provider.prepareExecution!(lease as never, intent);
    assert.equal(plan.executable, docker);
    assert.deepEqual(plan.arguments, ["start", "--attach", containerId]);
    assert.equal(JSON.stringify(plan).includes("approved-inside-container"), false);
    assert.equal(readFileSync(join(fixture.state, "oci-leases-oci-real-launch-plan.json"), "utf8").includes("approved-inside-container"), false);
    const result = await execFileResult(plan.executable, [...plan.arguments]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, Object.values(childEnvironment).join("|"));
    assert.equal(existsSync(join(fixture.state, "environment-handoffs")), false);
    await provider.release(lease as never);
    containerId = undefined;
  } finally {
    if (containerId) await execFileResult(docker, ["rm", "--force", containerId]);
    await fixture.close();
  }
});

test("real Docker strict interactive plan completes an exact JSON duplex roundtrip and leaves zero containers", async (t) => {
  const docker = availableDockerFixture();
  if (!docker) return t.skip("Docker unavailable; no installation attempted.");
  const fixture = await ociFixture();
  let containerId: string | undefined;
  try {
    const providerId = "oci-real-interactive";
    const provider = createOciExecutionIsolationProvider({
      providerId,
      cliPath: docker,
      image: "alpine:latest",
      stateDirectory: fixture.state,
    });
    const attestation = await provider.attest() as { interactiveAttach?: boolean };
    assert.equal(attestation.interactiveAttach, true);
    const intent = {
      ...fixture.intent,
      kind: "mcp_server" as const,
      executable: "sh",
      arguments: ["-c", "IFS= read -r line; printf '%s\\n' \"$line\""],
    };
    const lease = await provider.acquire({
      providerId,
      implementationDigest: "f".repeat(64),
      intent,
      grant: fixture.claims,
    });
    containerId = durableContainerId(fixture.state, providerId);
    const plan = await provider.prepareExecution!(lease as never, intent);
    assert.deepEqual(plan.arguments, ["start", "--attach", "--interactive", containerId]);
    const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize" });
    const result = await execFileInputResult(plan.executable, plan.arguments, `${request}\n`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), request);
    await provider.release(lease as never);
    containerId = undefined;
    assert.equal((await execFileResult(docker, [
      "ps", "-aq", "--filter", `label=ai-board.runner-v2.provider=${providerId}`,
    ])).stdout.trim(), "");
  } finally {
    if (containerId) await execFileResult(docker, ["rm", "--force", containerId]);
    await fixture.close();
  }
});

test("real Docker strict attach cancellation and external disappearance leave zero owned containers", { timeout: 90_000 }, async (t) => {
  const docker = availableDockerFixture();
  if (!docker) return t.skip("Docker unavailable; strict cancellation/disappearance was not weakened or emulated.");
  const fixture = await ociFixture();
  const providerId = "oci-real-interactive-lifecycle";
  let containerId: string | undefined;
  let attached: ReturnType<typeof spawn> | undefined;
  try {
    const provider = createOciExecutionIsolationProvider({
      providerId,
      cliPath: docker,
      image: "alpine:latest",
      stateDirectory: fixture.state,
    });
    const attestation = await provider.attest() as { interactiveAttach?: boolean };
    assert.equal(attestation.interactiveAttach, true);
    const intent = {
      ...fixture.intent,
      kind: "mcp_server" as const,
      executable: "sh",
      arguments: ["-c", "while :; do sleep 1; done"],
    };
    const lease = await provider.acquire({
      providerId,
      implementationDigest: "f".repeat(64),
      intent,
      grant: fixture.claims,
    });
    containerId = durableContainerId(fixture.state, providerId);
    const plan = await provider.prepareExecution!(lease as never, intent);
    assert.deepEqual(plan.arguments, ["start", "--attach", "--interactive", containerId]);
    attached = spawn(plan.executable, [...plan.arguments], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForDockerRunning(docker, containerId, 30_000);
    await terminateAttachedClient(attached, 10_000);
    attached = undefined;
    await provider.release(lease as never);
    containerId = undefined;
    await assertNoOwnedDockerContainers(docker, providerId);

    const disappearedIntent = { ...intent, invocationId: "invocation-disappeared" };
    await provider.acquire({
      providerId,
      implementationDigest: "f".repeat(64),
      intent: disappearedIntent,
      grant: fixture.claims,
    });
    containerId = durableContainerId(fixture.state, providerId);
    const removed = await execFileResult(docker, ["rm", "--force", containerId]);
    assert.equal(removed.code, 0, removed.stderr);
    containerId = undefined;
    const restarted = createOciExecutionIsolationProvider({
      providerId,
      cliPath: docker,
      image: "alpine:latest",
      stateDirectory: fixture.state,
    });
    await restarted.attest();
    const recovered = await restarted.recoverOwned();
    assert.equal(recovered.cleaned, 1);
    assert.deepEqual(recovered.blockers, []);
    assert.equal(recovered.transitions?.[0]?.status, "cleaned");
    await restarted.acknowledgeRecovery(recovered.transitions ?? []);
    assert.equal(durableLeaseCount(fixture.state, providerId), 0);
    await assertNoOwnedDockerContainers(docker, providerId);
  } finally {
    if (attached) await terminateAttachedClient(attached, 10_000).catch(() => undefined);
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
    await provider.acquire({
      providerId: "oci-real-mismatch",
      implementationDigest: "d".repeat(64),
      intent: { ...fixture.intent, executable: "sh", arguments: ["-c", "true"] },
      grant: fixture.claims,
    });
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

function fakeCli(
  calls: OciCliInvocation[],
  options: {
    interactiveAttach?: boolean;
    semanticDuplex?: boolean;
    imageExecutables?: readonly string[];
  } = {},
) {
  const labelsByContainer = new Map<string, Record<string, string>>();
  const imageByContainer = new Map<string, string>();
  const idByName = new Map<string, string>();
  let createdCount = 0;
  let probeCount = 0;
  const runner = {
    psOutput: "",
    imageIds: [] as string[],
    environmentFiles: [] as Record<string, string>[],
    environmentFilePaths: [] as string[],
    setImage(containerId: string, imageId: string) { imageByContainer.set(containerId, imageId); },
    removeExternally(containerId: string) {
      labelsByContainer.delete(containerId);
      imageByContainer.delete(containerId);
      for (const [name, id] of idByName) if (id === containerId) idByName.delete(name);
    },
    async run(invocation: OciCliInvocation) {
      calls.push(structuredClone(invocation));
      const [command] = invocation.args;
      if (command === "help" && invocation.args[1] === "create") {
        return {
          exitCode: 0,
          stdout: options.interactiveAttach === false ? "Usage: create" : "Usage: create --interactive",
          stderr: "",
        };
      }
      if (command === "help" && invocation.args[1] === "start") {
        return {
          exitCode: 0,
          stdout: options.interactiveAttach === false ? "Usage: start --attach" : "Usage: start --attach --interactive",
          stderr: "",
        };
      }
      if (command === "run") {
        const executable = invocation.args.at(-1);
        const available = (options.imageExecutables ?? ["sh", "node"]).includes(executable ?? "");
        return {
          exitCode: available ? 0 : 127,
          stdout: available ? `${executable}\n` : "",
          stderr: available ? "" : `${executable}: not found`,
        };
      }
      if (command === "image") {
        return { exitCode: 0, stdout: (runner.imageIds.shift() ?? "sha256:" + "1".repeat(64)) + "\n", stderr: "" };
      }
      if (command === "create") {
        const environmentFile = optionValues(invocation.args, "--env-file")[0];
        if (environmentFile) {
          runner.environmentFilePaths.push(environmentFile);
          runner.environmentFiles.push(Object.fromEntries(
            readFileSync(environmentFile, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
          ));
        }
        const probe = isProbeCreate(invocation);
        if (probe) probeCount += 1; else createdCount += 1;
        const containerId = probe ? `probe-fixture-${probeCount}` : `container-fixture-${createdCount}`;
        idByName.set(optionValues(invocation.args, "--name")[0]!, containerId);
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
        if (invocation.args.includes(`label=ai-board.runner-v2.probe=true`)) {
          const probes = [...labelsByContainer]
            .filter(([, labels]) => labels["ai-board.runner-v2.probe"] === "true")
            .map(([id]) => id);
          return { exitCode: 0, stdout: probes.length > 0 ? `${probes.join("\n")}\n` : "", stderr: "" };
        }
        return { exitCode: 0, stdout: runner.psOutput, stderr: "" };
      }
      if (command === "start") {
        const id = invocation.args.at(-1)!;
        return labelsByContainer.has(id)
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "not found" };
      }
      if (command === "inspect") {
        if (invocation.args.includes("{{.Id}}")) {
          const id = idByName.get(invocation.args.at(-1)!);
          return id ? { exitCode: 0, stdout: `${id}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "not found" };
        }
        if (invocation.args.includes("{{.Image}}")) {
          const image = imageByContainer.get(invocation.args.at(-1)!);
          return image ? { exitCode: 0, stdout: `${image}\n`, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "not found" };
        }
        if (invocation.args.includes("{{.Name}}")) {
          const id = invocation.args.at(-1)!;
          const name = [...idByName].find(([, value]) => value === id)?.[0];
          return name ? { exitCode: 0, stdout: `/${name}\n`, stderr: "" }
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
        const id = invocation.args.at(-1)!;
        labelsByContainer.delete(id);
        imageByContainer.delete(id);
        for (const [name, value] of idByName) if (value === id) idByName.delete(name);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected fake command" };
    },
    async runDuplex(invocation: OciCliInvocation, input: string) {
      calls.push(structuredClone(invocation));
      if (invocation.args[0] !== "start" || !invocation.args.includes("--attach") ||
          !invocation.args.includes("--interactive")) {
        return { exitCode: 1, stdout: "", stderr: "unexpected fake duplex command" };
      }
      return options.interactiveAttach === false || options.semanticDuplex === false
        ? { exitCode: 0, stdout: "wrong-token", stderr: "" }
        : { exitCode: 0, stdout: input.trimEnd(), stderr: "" };
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
      requiredLifecycleScope: "contained_workload" as const,
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

function isProbeCreate(invocation: Pick<OciCliInvocation, "args">): boolean {
  return invocation.args[0] === "create" &&
    optionValues(invocation.args, "--label").includes("ai-board.runner-v2.probe=true");
}

function workloadCreates(calls: readonly OciCliInvocation[]): OciCliInvocation[] {
  return calls.filter((call) => call.args[0] === "create" && !isProbeCreate(call));
}

function workloadRemoves(calls: readonly OciCliInvocation[]): OciCliInvocation[] {
  return calls.filter((call) => call.args[0] === "rm" &&
    !String(call.args.at(-1)).startsWith("probe-fixture-") &&
    !String(call.args.at(-1)).startsWith("aiboard-probe-"));
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
  } catch (error) {
    if (process.env.RUNNER_V2_REQUIRE_DOCKER === "1") {
      throw new Error("Required real Docker OCI integration is unavailable or alpine:latest is not prepared.", { cause: error });
    }
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

async function waitForDockerRunning(
  executable: string,
  containerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspected = await execFileResult(executable, [
      "inspect", "--format", "{{.State.Running}}", containerId,
    ]);
    if (inspected.code === 0 && inspected.stdout.trim() === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Configured Docker container did not become running within its test bound.");
}

async function terminateAttachedClient(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", () => resolvePromise());
  });
  child.kill("SIGKILL");
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Configured Docker attach client did not close within its test bound.")), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function assertNoOwnedDockerContainers(executable: string, providerId: string): Promise<void> {
  const listed = await execFileResult(executable, [
    "ps", "-aq", "--filter", `label=ai-board.runner-v2.provider=${providerId}`,
  ]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), "");
}

async function execFileInputResult(
  executable: string,
  args: readonly string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Configured Docker duplex fixture exceeded its 30 second test bound."));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
