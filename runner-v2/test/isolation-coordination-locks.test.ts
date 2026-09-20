import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  ExecutionIsolationError,
  createExecutionIsolationRegistry,
  createExecutionIsolationSelector,
} from "../src/execution-isolation-provider.js";
import {
  OciExecutionIsolationError,
  createOciExecutionIsolationProvider,
} from "../src/oci-execution-isolation-provider.js";

const holderFixture = fileURLToPath(
  new URL("./fixtures/owned-fence-lock-holder.mjs", import.meta.url),
);

test("crashed exact holders are recovered by OCI lease and enforcement projection state", { timeout: 35_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-isolation-lock-crash-"));
  try {
    const oci = await ociStateFixture(root, "crash");
    await crashHolder(oci.lockPath);
    assert.deepEqual(await oci.provider.recoverOwned(), {
      cleaned: 0,
      blockers: [],
      transitions: [],
    });
    assert.equal(oci.psCalls(), 1);
    assertCoordinationIdle(oci.lockPath);
    await oci.provider.recoverOwned();
    assert.equal(oci.psCalls(), 2);
    assertCoordinationIdle(oci.lockPath);

    const projectionPath = join(root, "enforcement-crash.json");
    await crashHolder(`${projectionPath}.lock`);
    await writeFullProjection(root, projectionPath, "crash");
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      records: Array<{ status: string }>;
    };
    assert.deepEqual(projection.records.map((record) => record.status), [
      "unconfined_explicit_full",
    ]);
    assertCoordinationIdle(`${projectionPath}.lock`);
    await writeFullProjection(root, projectionPath, "crash-next");
    assert.equal((JSON.parse(await readFile(projectionPath, "utf8")) as { records: unknown[] }).records.length, 2);
    assertCoordinationIdle(`${projectionPath}.lock`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("live exact holders are not stolen before OCI and projection state effects", { timeout: 35_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-isolation-lock-live-"));
  let ociHolder: ChildProcess | undefined;
  let projectionHolder: ChildProcess | undefined;
  try {
    const oci = await ociStateFixture(root, "live");
    ociHolder = startHolder(oci.lockPath, 750);
    assert.equal((await nextMessage(ociHolder)).state, "acquired");
    const ociStartedAt = Date.now();
    const recovery = await oci.provider.recoverOwned();
    assert.ok(Date.now() - ociStartedAt >= 500, "a live holder must retain exclusive OCI state authority");
    await waitForExit(ociHolder);
    ociHolder = undefined;
    assert.deepEqual(recovery, { cleaned: 0, blockers: [], transitions: [] });
    assertCoordinationIdle(oci.lockPath);

    const projectionPath = join(root, "enforcement-live.json");
    projectionHolder = startHolder(`${projectionPath}.lock`, 750);
    assert.equal((await nextMessage(projectionHolder)).state, "acquired");
    const projectionStartedAt = Date.now();
    await writeFullProjection(root, projectionPath, "live");
    assert.ok(Date.now() - projectionStartedAt >= 500, "a live holder must retain exclusive projection authority");
    await waitForExit(projectionHolder);
    projectionHolder = undefined;
    assertCoordinationIdle(`${projectionPath}.lock`);
  } finally {
    if (ociHolder) await killAndWait(ociHolder);
    if (projectionHolder) await killAndWait(projectionHolder);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("forged coordination is refused without OCI or projection state mutation", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-isolation-lock-forged-"));
  try {
    const forged = Buffer.from("foreign coordination evidence");
    const oci = await ociStateFixture(root, "forged");
    await writeFile(oci.lockPath, forged);
    await assert.rejects(
      oci.provider.recoverOwned(),
      (error: unknown) => error instanceof OciExecutionIsolationError &&
        error.code === "oci_recovery_blocked",
    );
    assert.deepEqual(await readFile(oci.lockPath), forged);
    assert.equal(oci.psCalls(), 0);

    const projectionPath = join(root, "enforcement-forged.json");
    const projectionLock = `${projectionPath}.lock`;
    await writeFile(projectionLock, forged);
    await assert.rejects(
      writeFullProjection(root, projectionPath, "forged"),
      (error: unknown) => error instanceof ExecutionIsolationError &&
        error.code === "isolation_recovery_blocked",
    );
    assert.deepEqual(await readFile(projectionLock), forged);
    await assert.rejects(readFile(projectionPath), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

async function ociStateFixture(root: string, suffix: string) {
  const stateDirectory = join(root, `oci-${suffix}`);
  const cliPath = join(root, process.platform === "win32" ? `oci-${suffix}.exe` : `oci-${suffix}`);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(cliPath, "fixture OCI executable identity");
  if (process.platform !== "win32") await chmod(cliPath, 0o700);
  let psCalls = 0;
  const provider = createOciExecutionIsolationProvider({
    providerId: `oci-lock-${suffix}`,
    cliPath,
    image: "fixture:immutable",
    stateDirectory,
    cli: {
      async run(invocation) {
        if (invocation.args[0] !== "ps") {
          throw new Error(`Unexpected OCI fixture call: ${invocation.args.join(" ")}`);
        }
        psCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  });
  return {
    provider,
    lockPath: join(stateDirectory, `oci-leases-oci-lock-${suffix}.json.lock`),
    psCalls: () => psCalls,
  };
}

async function writeFullProjection(root: string, statePath: string, suffix: string): Promise<void> {
  const workspace = join(root, `workspace-${suffix}`);
  await mkdir(workspace, { recursive: true });
  const authority = createExecutionGrantAuthority();
  const binding = {
    runId: `run-${suffix}`,
    sessionId: `session-${suffix}`,
    actor: { role: "worker" as const, id: `worker-${suffix}` },
    toolName: "process.run",
    callId: `call-${suffix}`,
    permissionProfile: "full" as const,
  };
  const intent = {
    invocationId: `invocation-${suffix}`,
    runId: binding.runId,
    sessionId: binding.sessionId,
    kind: "command" as const,
    executable: process.execPath,
    arguments: [] as string[],
    workingDirectory: workspace,
    requiredLifecycleScope: "process_group" as const,
    requestedCapabilities: [] as const,
  };
  const grant = await authority.issue({
    ...binding,
    workspacePath: workspace,
    access: [{ path: workspace, mode: "write" }],
    externalApproved: false,
    destructiveApproved: false,
    networkApproved: false,
  });
  const selector = createExecutionIsolationSelector(
    createExecutionIsolationRegistry([]),
    { statePath },
  );
  await selector.acquire({
    permissionProfile: "full",
    intent,
    grant: authority.consume(grant, binding),
  });
}

function startHolder(lockPath: string, holdMs = 60_000): ChildProcess {
  return spawn(process.execPath, [
    holderFixture,
    "hold",
    lockPath,
    "",
    "10000",
    String(holdMs),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

async function crashHolder(lockPath: string): Promise<void> {
  const holder = startHolder(lockPath);
  try {
    assert.equal((await nextMessage(holder)).state, "acquired");
    await killAndWait(holder);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) await killAndWait(holder);
  }
}

async function nextMessage(child: ChildProcess): Promise<{ state: string }> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try { resolve(JSON.parse(stdout.slice(0, newline)) as { state: string }); }
      catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) reject(new Error(`Lock holder exited ${code}: ${stderr}`));
    });
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function assertCoordinationIdle(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT retired FROM owned_fence_protocol").get()?.retired, 0);
    assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count), 0);
    assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count), 0);
  } finally {
    database.close();
  }
}
