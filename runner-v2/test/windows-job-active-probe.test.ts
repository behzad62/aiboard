import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";

async function withProbeTransport(
  transport: (command: string, options: SpawnSyncOptions) => SpawnSyncReturns<Buffer>,
  check: (probe: () => Promise<boolean>) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-job-active-probe-control-"));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalSpawnSync = childProcess.spawnSync;
  try {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
    childProcess.spawnSync = ((executable: string, args: string[], options: SpawnSyncOptions) => {
      assert.equal(executable, "powershell.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      assert.equal(args.length, 5);
      assert.equal(options.timeout, 5_000);
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio, "ignore");
      return transport(args[4]!, options);
    }) as typeof childProcess.spawnSync;
    syncBuiltinESMExports();
    const host = createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
    await check(() => host.probeActiveJobCreateClose());
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", originalPlatform);
    rmSync(root, { recursive: true, force: true });
  }
}

const result = (status: number | null, error?: Error): SpawnSyncReturns<Buffer> => ({
  pid: 1, status, signal: status === null ? "SIGKILL" : null,
  output: [null, Buffer.alloc(0), Buffer.alloc(0)], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error,
});

test("active Job availability is independent of runtime C# compiler availability", async () => {
  await withProbeTransport(command => command.includes("Add-Type")
    ? result(null, Object.assign(new Error("cold compiler exceeded original deadline"), { code: "ETIMEDOUT" }))
    : result(0), async probe => assert.equal(await probe(), true));
});

test("failed, expired and inconsistent active Job probe results remain unqualified", async () => {
  for (const failure of [result(1), result(null, Object.assign(new Error("probe deadline"), { code: "ETIMEDOUT" })), result(0, new Error("transport failed"))]) {
    await withProbeTransport(() => failure, async probe => assert.equal(await probe(), false));
  }
});
