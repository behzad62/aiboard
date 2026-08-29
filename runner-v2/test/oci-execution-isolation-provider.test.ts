import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import test from "node:test";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  OciExecutionIsolationError,
  createOciExecutionIsolationProvider,
  type OciCliInvocation,
} from "../src/oci-execution-isolation-provider.js";

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

    await provider.release(lease as never);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("--force")), true);
    assert.deepEqual(await provider.recoverOwned(), { cleaned: 0, blockers: [] });
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
    cli.psOutput = "container-fixture-1\nunknown-container\n";
    const recovered = await provider.recoverOwned();
    assert.equal(recovered.cleaned, 1);
    assert.equal(recovered.blockers.length, 1);
    assert.match(recovered.blockers[0]!, /unknown-container/);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("container-fixture-1")), true);
    assert.equal(calls.some((call) => call.args[0] === "rm" && call.args.includes("unknown-container")), false);
  } finally {
    await fixture.close();
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

    assert.deepEqual(recovered, { cleaned: 1, blockers: [] });
    assert.equal(durableLeaseCount(fixture.state, "oci-stale"), 0);
    assert.equal(calls.some((call) => call.args[0] === "inspect"), true);
    assert.equal(calls.some((call) => call.args[0] === "rm"), false);
  } finally {
    await fixture.close();
  }
});

test("real Docker fixture denies outside writes, symlink escalation, network, and cleans a live child", async (t) => {
  const docker = availableDockerFixture();
  if (!docker) {
    t.skip("Docker-compatible CLI/daemon or pre-existing alpine:latest image is unavailable; no installation or pull attempted.");
    return;
  }
  const fixture = await ociFixture();
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
    const lease = await provider.acquire({
      providerId: "oci-real",
      implementationDigest: "a".repeat(64),
      intent,
      grant: fixture.claims,
    });
    const containerId = durableContainerId(fixture.state, "oci-real");
    const start = await execFileResult(docker, ["start", "--attach", containerId]);
    assert.equal(start.code, 0, start.stderr);
    assert.equal(existsSync(insideSentinel), true);
    assert.equal(existsSync(deniedOutside), false);
    assert.equal(existsSync(join(fixture.external, "symlink-write")), false);
    assert.equal(existsSync(networkSentinel), false);
    await provider.release(lease as never);
    assert.equal((await execFileResult(docker, ["inspect", containerId])).code, 1);

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
      assert.equal((await execFileResult(docker, ["start", liveId])).code, 0);
      await liveProvider.release(liveLease as never);
      assert.equal((await execFileResult(docker, ["inspect", liveId])).code, 1);
    } finally {
      await liveFixture.close();
    }
  } finally {
    await fixture.close();
  }
});

function fakeCli(calls: OciCliInvocation[]) {
  const labelsByContainer = new Map<string, Record<string, string>>();
  const runner = {
    psOutput: "",
    removeExternally(containerId: string) {
      labelsByContainer.delete(containerId);
    },
    async run(invocation: OciCliInvocation) {
      calls.push(structuredClone(invocation));
      const [command] = invocation.args;
      if (command === "image") {
        return { exitCode: 0, stdout: "sha256:" + "1".repeat(64) + "\n", stderr: "" };
      }
      if (command === "create") {
        labelsByContainer.set("container-fixture-1", Object.fromEntries(
          optionValues(invocation.args, "--label").map((label) => {
            const separator = label.indexOf("=");
            return [label.slice(0, separator), label.slice(separator + 1)];
          }),
        ));
        return { exitCode: 0, stdout: "container-fixture-1\n", stderr: "" };
      }
      if (command === "ps") {
        return { exitCode: 0, stdout: runner.psOutput, stderr: "" };
      }
      if (command === "inspect") {
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
