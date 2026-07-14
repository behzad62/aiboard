import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolResult } from "../src/agent-contracts.js";
import { ManagedProcessService } from "../src/managed-process.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { ToolBroker } from "../src/tool-broker.js";

test("background process output and ownership survive service restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  const firstService = new ManagedProcessService({
    stateDirectory: state,
    idFactory: () => "process_1",
  });
  const owner = broker(workspace, firstService, "session_owner");
  try {
    const started = await invoke(owner, "start", "process.start", {
      command: process.execPath,
      args: [
        "-e",
        "console.log('ready'); console.error('diagnostic'); setInterval(() => {}, 1000)",
      ],
      env: { AIBOARD_TEST_SECRET: "never-write-this-secret" },
    });
    assert.equal(started.isError, false);
    assert.equal((json(started) as { processId: string }).processId, "process_1");
    const observed = firstService.listRun("run_1");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].sessionId, "session_owner");
    assert.equal(observed[0].command, process.execPath);
    let pollAttempt = 0;
    await waitFor(async () => text(await invoke(owner, `poll_initial_${pollAttempt++}`, "process.poll", {
      processId: "process_1",
    })).includes("ready"));

    const recoveredService = new ManagedProcessService({ stateDirectory: state });
    const recoveredOwner = broker(workspace, recoveredService, "session_owner");
    const recovered = await invoke(recoveredOwner, "poll_2", "process.poll", {
      processId: "process_1",
    });
    assert.equal((json(recovered) as { status: string }).status, "running");
    assert.match(text(recovered), /ready/);
    assert.match(text(recovered), /diagnostic/);

    const otherSession = broker(workspace, recoveredService, "session_other");
    const denied = await invoke(otherSession, "signal_denied", "process.signal", {
      processId: "process_1",
      signal: "SIGTERM",
    });
    assert.equal(denied.error?.code, "process_not_owned");

    const stopped = await invoke(recoveredOwner, "signal_owner", "process.signal", {
      processId: "process_1",
      signal: "SIGTERM",
    });
    assert.equal(stopped.isError, false);
    await waitFor(async () => {
      const polled = await invoke(recoveredOwner, `poll_${Date.now()}`, "process.poll", {
        processId: "process_1",
      });
      return (json(polled) as { status: string }).status !== "running";
    });
    const persisted = JSON.parse(
      readFileSync(join(state, "process_1.json"), "utf8")
    ) as { supervisor?: { protocol?: string; token?: string; port?: number } };
    assert.equal(persisted.supervisor?.protocol, "aiboard-managed-process/v1");
    assert.equal(typeof persisted.supervisor?.token, "string");
    assert.ok((persisted.supervisor?.token?.length ?? 0) >= 32);
    assert.equal(typeof persisted.supervisor?.port, "number");
    const supervisorStatuses = readFileSync(
      join(state, "process_1", "supervisor.jsonl"),
      "utf8"
    ).trim().split(/\r?\n/);
    const finalSupervisorStatus = JSON.parse(supervisorStatuses.at(-1) ?? "{}") as {
      status?: string;
      ownershipReleased?: boolean;
    };
    assert.deepEqual(
      { status: finalSupervisorStatus.status, ownershipReleased: finalSupervisorStatus.ownershipReleased },
      { status: "stopped", ownershipReleased: true }
    );
    assert.doesNotMatch(readTextTree(state), /never-write-this-secret/);
    recoveredService.close();
  } finally {
    firstService.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

test("restart hydrates a port-zero durable handshake record before authenticated stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-handshake-crash-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  const firstService = new ManagedProcessService({
    stateDirectory: state,
    idFactory: () => "handshake_crash",
  });
  const owner = broker(workspace, firstService, "session_owner");
  let childPid = 0;
  try {
    const started = await invoke(owner, "handshake_start", "process.start", {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    assert.equal(started.isError, false, text(started));
    childPid = (json(started) as { pid: number }).pid;
    const recordPath = join(state, "handshake_crash.json");
    const crashCheckpoint = JSON.parse(readFileSync(recordPath, "utf8")) as {
      pid: number;
      supervisor: { port: number };
    };
    assert.ok(crashCheckpoint.supervisor.port > 0);
    crashCheckpoint.pid = 0;
    crashCheckpoint.supervisor.port = 0;
    writeFileSync(recordPath, JSON.stringify(crashCheckpoint, null, 2));
    firstService.close();

    const recovered = new ManagedProcessService({ stateDirectory: state });
    try {
      await recovered.stopRun("run_1");
      await waitForPidExit(childPid);
      const persisted = JSON.parse(readFileSync(recordPath, "utf8")) as {
        status: string;
        supervisor: { port: number };
      };
      assert.equal(persisted.status, "stopped");
      assert.ok(persisted.supervisor.port > 0, "JSONL handshake was not hydrated");
    } finally {
      recovered.close();
    }
  } finally {
    firstService.close();
    try {
      const recordPath = join(state, "handshake_crash.json");
      const cleanupRecord = JSON.parse(readFileSync(recordPath, "utf8")) as {
        supervisor: { port: number; statusPath: string };
      };
      if (cleanupRecord.supervisor.port === 0) {
        const statuses = readFileSync(cleanupRecord.supervisor.statusPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { port: number });
        cleanupRecord.supervisor.port = statuses.findLast((status) => status.port > 0)?.port ?? 0;
        writeFileSync(recordPath, JSON.stringify(cleanupRecord, null, 2));
      }
      const cleanup = new ManagedProcessService({ stateDirectory: state });
      try {
        await cleanup.stopRun("run_1");
      } finally {
        cleanup.close();
      }
    } catch {
      // The assertion failure remains primary; the verified process PID is a last-resort test cleanup.
      if (childPid > 0 && isPidAlive(childPid)) process.kill(childPid, "SIGKILL");
    }
    await waitForPidExit(childPid);
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("a crash before supervisor configuration durably proves that no backend launched", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-preconfig-crash-"));
  const state = join(root, "state");
  const processId = "preconfig_crash";
  const processDirectory = join(state, processId);
  const statusPath = join(processDirectory, "supervisor.jsonl");
  mkdirSync(processDirectory, { recursive: true });
  const supervisorScript = fileURLToPath(
    new URL("../src/managed-process-supervisor.mjs", import.meta.url)
  );
  const launcher = spawn(process.execPath, [supervisorScript, processId, statusPath], {
    detached: true,
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore", "ipc"],
  });
  assert.ok(launcher.pid);
  const supervisorPid = launcher.pid;
  const now = new Date().toISOString();
  writeFileSync(join(state, `${processId}.json`), JSON.stringify({
    processId,
    pid: 0,
    runId: "run_1",
    sessionId: "session_owner",
    actor: { role: "worker", id: "session_owner" },
    command: "never-launched",
    args: [],
    cwd: root,
    environmentKeys: [],
    startedAt: now,
    updatedAt: now,
    status: "running",
    exitCode: null,
    signal: null,
    stdoutPath: join(processDirectory, "stdout.log"),
    stderrPath: join(processDirectory, "stderr.log"),
    supervisor: {
      protocol: "aiboard-managed-process/v1",
      token: "a".repeat(64),
      statusPath,
      supervisorPid,
      port: 0,
    },
  }, null, 2));

  try {
    launcher.stdin?.end();
    await waitForPidExit(supervisorPid);
    const recovered = new ManagedProcessService({ stateDirectory: state });
    try {
      await recovered.stopRun("run_1");
      const persisted = JSON.parse(
        readFileSync(join(state, `${processId}.json`), "utf8")
      ) as { status: string; supervisor: { port: number } };
      assert.equal(persisted.status, "stopped");
      assert.equal(persisted.supervisor.port, 0);
      const statuses = readFileSync(statusPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as {
          childPid: number;
          status: string;
          ownershipReleased: boolean;
        });
      assert.deepEqual(
        {
          childPid: statuses.at(-1)?.childPid,
          status: statuses.at(-1)?.status,
          ownershipReleased: statuses.at(-1)?.ownershipReleased,
        },
        { childPid: 0, status: "stopped", ownershipReleased: true }
      );
    } finally {
      recovered.close();
    }
  } finally {
    if (isPidAlive(supervisorPid)) launcher.kill("SIGKILL");
    await waitForPidExit(supervisorPid);
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("an ambiguous port-zero record without a bootstrap journal fails closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-ambiguous-preconfig-"));
  const state = join(root, "state");
  mkdirSync(state);
  const now = new Date().toISOString();
  writeFileSync(join(state, "ambiguous.json"), JSON.stringify({
    processId: "ambiguous",
    pid: 0,
    runId: "run_1",
    sessionId: "session_owner",
    actor: { role: "worker", id: "session_owner" },
    command: "unknown",
    args: [],
    cwd: root,
    environmentKeys: [],
    startedAt: now,
    updatedAt: now,
    status: "running",
    exitCode: null,
    signal: null,
    stdoutPath: join(state, "stdout.log"),
    stderrPath: join(state, "stderr.log"),
    supervisor: {
      protocol: "aiboard-managed-process/v1",
      token: "b".repeat(64),
      statusPath: join(state, "missing-supervisor.jsonl"),
      supervisorPid: process.pid,
      port: 0,
    },
  }, null, 2));
  const service = new ManagedProcessService({ stateDirectory: state });
  try {
    await assert.rejects(service.stopRun("run_1"), /Could not stop all managed processes/);
    assert.equal(isPidAlive(process.pid), true);
    const persisted = JSON.parse(readFileSync(join(state, "ambiguous.json"), "utf8")) as {
      status: string;
    };
    assert.equal(persisted.status, "exited_unknown");
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("process.start refuses unavailable containment before creating or launching anything", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-no-containment-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const supervisorScript = join(root, "must-not-launch.mjs");
  const marker = join(root, "launched.txt");
  mkdirSync(workspace);
  writeFileSync(supervisorScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`);
  let allocated = false;
  const service = new ManagedProcessService({
    stateDirectory: state,
    platform: "linux",
    idFactory: () => {
      allocated = true;
      return "must_not_exist";
    },
    supervisorScriptPath: supervisorScript,
  });
  const owner = broker(workspace, service, "session_owner");
  try {
    const result = await invoke(owner, "no_containment", "process.start", {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "process_containment_unavailable");
    assert.equal(allocated, false);
    assert.equal(readdirSync(state).length, 0);
    assert.equal(readdirSync(root).includes("launched.txt"), false);
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows Job host resolves an extensionless executable through PATH", async (contextValue) => {
  if (process.platform !== "win32") {
    contextValue.skip("Windows PATH resolution is exercised by the Job Object backend.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-path-"));
  const workspace = join(root, "workspace");
  const shimBin = join(root, "shim-bin");
  const shimMarker = join(root, "shim-launched.txt");
  mkdirSync(workspace);
  mkdirSync(shimBin);
  writeFileSync(
    join(shimBin, "node.cmd"),
    `@ECHO OFF\r\nECHO unsafe>${shimMarker}\r\n`
  );
  const service = new ManagedProcessService({
    stateDirectory: join(root, "state"),
    idFactory: () => "path_command",
  });
  const owner = broker(workspace, service, "session_owner");
  try {
    const started = await invoke(owner, "path_start", "process.start", {
      command: "node",
      args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "space value", "literal&value"],
      env: {
        PATH: `${shimBin};${dirname(process.execPath)};${process.env.PATH ?? ""}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    });
    assert.equal(started.isError, false, text(started));
    await waitFor(async () => {
      const snapshot = service.poll("path_command", context("session_owner"));
      return snapshot.status === "stopped";
    });
    assert.match(service.poll("path_command", context("session_owner")).stdout, /\["space value","literal&value"\]/);
    assert.equal(readdirSync(root).includes("shim-launched.txt"), false);
  } finally {
    await service.stopRun("run_1").catch(() => undefined);
    service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("Windows Job host launches npm-style PATHEXT cmd shims with argv boundaries", async (contextValue) => {
  if (process.platform !== "win32") {
    contextValue.skip("Windows PATHEXT script launch is exercised by the Job Object backend.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-cmd-"));
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const capture = join(root, "captured.json");
  mkdirSync(workspace);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "capture.js"),
    "require('node:fs').writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)))"
  );
  writeFileSync(
    join(bin, "safe-shim.cmd"),
    "@ECHO OFF\r\nnode \"%~dp0\\capture.js\" %*\r\n"
  );
  const service = new ManagedProcessService({
    stateDirectory: join(root, "state"),
    idFactory: () => "cmd_command",
  });
  const owner = broker(workspace, service, "session_owner");
  try {
    const started = await invoke(owner, "cmd_start", "process.start", {
      command: "safe-shim",
      args: ["run", "dev", "--", "--port", "3000", "space value"],
      env: {
        PATH: `${bin};${process.env.PATH ?? ""}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        CAPTURE_PATH: capture,
      },
    });
    assert.equal(started.isError, false, text(started));
    await waitFor(async () => service.poll("cmd_command", context("session_owner")).status === "stopped");
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), [
      "run",
      "dev",
      "--",
      "--port",
      "3000",
      "space value",
    ]);
  } finally {
    await service.stopRun("run_1").catch(() => undefined);
    service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("Windows Job host rejects cmd shim shell syntax instead of interpreting it", async (contextValue) => {
  if (process.platform !== "win32") {
    contextValue.skip("Windows PATHEXT script launch is exercised by the Job Object backend.");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-cmd-reject-"));
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const injected = join(root, "injected.txt");
  mkdirSync(workspace);
  mkdirSync(bin);
  writeFileSync(join(bin, "unsafe-shim.cmd"), "@ECHO OFF\r\nECHO %*\r\n");
  const service = new ManagedProcessService({
    stateDirectory: join(root, "state"),
    idFactory: () => "cmd_rejected",
  });
  const owner = broker(workspace, service, "session_owner");
  try {
    const result = await invoke(owner, "cmd_reject", "process.start", {
      command: "unsafe-shim",
      args: [`literal & echo injected>${injected}`],
      env: {
        PATH: `${bin};${process.env.PATH ?? ""}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "process_start_failed");
    assert.match(text(result), /Unsafe \.cmd\/\.bat argument rejected/);
    assert.equal(readdirSync(root).includes("injected.txt"), false);
  } finally {
    await service.stopRun("run_1").catch(() => undefined);
    service.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("background spawn failure is a structured tool error", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-error-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const service = new ManagedProcessService({ stateDirectory: join(root, "state") });
  const owner = broker(workspace, service, "session_owner");
  try {
    const result = await invoke(owner, "missing", "process.start", {
      command: join(root, "definitely-missing-executable.exe"),
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "process_start_failed");
    assert.deepEqual(
      readdirSync(join(root, "state"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          readdirSync(join(root, "state", entry.name))
            .filter((name) => name.startsWith("launch-"))
        ),
      []
    );
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor startup timeout aborts and reaps a late supervisor deterministically", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-timeout-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const supervisorScript = join(root, "late-supervisor.mjs");
  const marker = join(root, "fixture-started.txt");
  mkdirSync(workspace);
  writeFileSync(
    supervisorScript,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "started");\n` +
      `process.stdin.resume();\n` +
      `process.on("message", (message) => {\n` +
      `  if (message?.type !== "abort") return;\n` +
      `  process.send?.({ type: "abort_ack", token: message.token });\n` +
      `  process.exit(0);\n` +
      `});\n` +
      `setInterval(() => {}, 1000);\n`
  );
  const service = new ManagedProcessService({
    stateDirectory: state,
    idFactory: () => "timeout",
    startDeadlineMs: 100,
    supervisorScriptPath: supervisorScript,
  });
  const owner = broker(workspace, service, "session_owner");
  let supervisorPid = 0;
  try {
    const result = await invoke(owner, "timeout", "process.start", {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    assert.equal(result.isError, true);
    assert.equal(readFileSync(marker, "utf8"), "started");
    const record = JSON.parse(readFileSync(join(state, "timeout.json"), "utf8")) as {
      supervisor?: { supervisorPid?: number };
    };
    supervisorPid = record.supervisor?.supervisorPid ?? 0;
    await waitFor(async () => !isPidAlive(supervisorPid));
    assert.deepEqual(
      readdirSync(join(state, "timeout")).filter((name) => name.startsWith("launch-")),
      []
    );
  } finally {
    service.close();
    if (supervisorPid > 0 && isPidAlive(supervisorPid)) process.kill(supervisorPid, "SIGKILL");
    await waitForPidExit(supervisorPid);
    await new Promise((resolve) => setTimeout(resolve, 250));
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("legacy PID-only records fail closed and never authorize a signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-legacy-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
  });
  assert.ok(unrelated.pid);
  writeFileSync(
    join(state, "legacy.json"),
    JSON.stringify({
      processId: "legacy",
      pid: unrelated.pid,
      runId: "run_1",
      sessionId: "session_owner",
      actor: { role: "worker", id: "session_owner" },
      command: process.execPath,
      args: [],
      cwd: workspace,
      environmentKeys: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      exitCode: null,
      signal: null,
      stdoutPath: join(state, "missing.stdout"),
      stderrPath: join(state, "missing.stderr"),
    })
  );
  const service = new ManagedProcessService({ stateDirectory: state });
  const owner = broker(workspace, service, "session_owner");
  try {
    const result = await invoke(owner, "legacy_signal", "process.signal", {
      processId: "legacy",
      signal: "SIGKILL",
    });
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "process_control_unavailable");
    assert.equal(service.poll("legacy", context("session_owner")).status, "exited_unknown");
  } finally {
    service.close();
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (unrelated.exitCode !== null || unrelated.signalCode !== null) resolve();
      else unrelated.once("exit", () => resolve());
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("natural no-descendant exit is durably stopped after service restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-natural-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  const firstService = new ManagedProcessService({
    stateDirectory: state,
    idFactory: () => "natural",
  });
  const owner = broker(workspace, firstService, "session_owner");
  try {
    const started = await invoke(owner, "natural_start", "process.start", {
      command: process.execPath,
      args: ["-e", "console.log('done'); process.exit(7)"],
    });
    assert.equal(started.isError, false);
    await waitFor(async () => {
      const recovered = new ManagedProcessService({ stateDirectory: state });
      try {
        const snapshot = recovered.poll("natural", context("session_owner"));
        return snapshot.status === "stopped" && snapshot.exitCode === 7;
      } finally {
        recovered.close();
      }
    });
  } finally {
    firstService.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("controlled stop terminates a descendant after its launcher exits", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-descendant-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  const firstService = new ManagedProcessService({
    stateDirectory: state,
    idFactory: () => "descendant",
  });
  const owner = broker(workspace, firstService, "session_owner");
  let descendantPid = 0;
  try {
    const launcher = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform === 'win32', stdio: 'ignore' });",
      "child.unref();",
      "console.log(child.pid);",
      "setTimeout(() => process.exit(0), 50);",
    ].join(" ");
    const started = await invoke(owner, "descendant_start", "process.start", {
      command: process.execPath,
      args: ["-e", launcher],
    });
    assert.equal(started.isError, false, text(started));
    await waitFor(async () => {
      const snapshot = firstService.poll("descendant", context("session_owner"));
      const match = snapshot.stdout.match(/\b(\d+)\b/);
      if (match) descendantPid = Number(match[1]);
      return snapshot.status === "exited_unknown" && descendantPid > 0;
    });
    firstService.close();
    const recovered = new ManagedProcessService({ stateDirectory: state });
    try {
      await recovered.stopRun("run_1");
      await waitForPidExit(descendantPid);
      assert.equal(recovered.listRun("run_1")[0]?.status, "stopped");
    } finally {
      recovered.close();
    }
  } finally {
    firstService.close();
    if (descendantPid > 0 && isPidAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await waitForPidExit(descendantPid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("supervisor request timeout follows the configured stop deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-http-timeout-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const token = "a".repeat(64);
  const server = createServer((_request, _response) => {
    // Deliberately never respond.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const statusPath = join(state, "fake-supervisor.jsonl");
  const status = {
    protocol: "aiboard-managed-process/v1",
    processId: "fake",
    supervisorPid: process.pid,
    childPid: 123,
    port: address.port,
    status: "running",
    exitCode: null,
    signal: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(statusPath, `${JSON.stringify(status)}\n`);
  writeFileSync(join(state, "fake.json"), JSON.stringify({
    processId: "fake",
    pid: 123,
    runId: "run_1",
    sessionId: "session_owner",
    actor: { role: "worker", id: "session_owner" },
    command: "fixture",
    args: [],
    cwd: workspace,
    environmentKeys: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    signal: null,
    stdoutPath: join(state, "fake.stdout"),
    stderrPath: join(state, "fake.stderr"),
    supervisor: {
      protocol: "aiboard-managed-process/v1",
      token,
      statusPath,
      supervisorPid: process.pid,
      port: address.port,
    },
  }));
  const service = new ManagedProcessService({ stateDirectory: state, stopDeadlineMs: 75 });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      service.signal("fake", "SIGTERM", context("session_owner")),
      /could not confirm termination/i
    );
    assert.ok(Date.now() - startedAt < 1_000, "request ignored configured stop deadline");
  } finally {
    service.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("stopRun waits until every supervised process has terminated", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-stop-run-"));
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  mkdirSync(workspace);
  const firstService = new ManagedProcessService({
    stateDirectory: state,
    idFactory: (() => {
      let id = 0;
      return () => `process_${++id}`;
    })(),
  });
  const owner = broker(workspace, firstService, "session_owner");
  try {
    for (const callId of ["one", "two"]) {
      const result = await invoke(owner, callId, "process.start", {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
      assert.equal(result.isError, false);
    }
    firstService.close();
    const recovered = new ManagedProcessService({ stateDirectory: state });
    try {
      await recovered.stopRun("run_1");
      assert.deepEqual(
        recovered.listRun("run_1").map((item) => item.status),
        ["stopped", "stopped"]
      );
    } finally {
      recovered.close();
    }
  } finally {
    firstService.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function broker(
  workspace: string,
  service: ManagedProcessService,
  sessionId: string
): ToolBroker & { sessionId: string } {
  const result = new ToolBroker({
    permissionProfile: "full",
    workspacePath: workspace,
  }) as ToolBroker & { sessionId: string };
  result.sessionId = sessionId;
  for (const tool of createManagedProcessTools(service)) result.register(tool);
  return result;
}

async function invoke(
  brokerValue: ToolBroker & { sessionId: string },
  callId: string,
  name: string,
  args: unknown
): Promise<ToolResult> {
  return await brokerValue.invoke(
    { type: "tool_call", callId, name, arguments: args },
    {
      runId: "run_1",
      sessionId: brokerValue.sessionId,
      actor: { role: "worker", id: brokerValue.sessionId },
    }
  );
}

function json(result: ToolResult): unknown {
  return result.content.find((block) => block.type === "json")?.value;
}

function text(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for managed process state.");
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function readTextTree(root: string): string {
  const values: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(readTextTree(path));
    else if (entry.isFile()) values.push(readFileSync(path, "utf8"));
  }
  return values.join("\n");
}

async function waitForPidExit(pid: number): Promise<void> {
  if (pid <= 0) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(isPidAlive(pid), false, `PID ${pid} did not exit during test cleanup.`);
}

function context(sessionId: string) {
  return {
    runId: "run_1",
    sessionId,
    actor: { role: "worker" as const, id: sessionId },
  };
}
