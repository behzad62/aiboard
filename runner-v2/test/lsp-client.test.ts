import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { LspClient, LspClientError } from "../src/lsp-client.js";
import { resolveLanguageServerExecutable } from "../src/language-server-executable.js";

const fixtureServer = resolve("runner-v2/test/fixtures/lsp-server.mjs");
const stalledWindowsJobHost = resolve("runner-v2/test/fixtures/lsp-stalled-job-host.ps1");

test("LSP client initializes over partial frames, synchronizes exact versions, cancels, and shuts down", async () => {
  const fixture = workspace("partial Ω");
  const exitMarker = join(fixture.root, "server-exit.json");
  const client = fixture.client({
    env: {
      LSP_FIXTURE_PARTIAL: "1",
      LSP_FIXTURE_EXIT_FILE: exitMarker,
      LSP_FIXTURE_CANCEL_RESPONSE: "1",
    },
  });
  try {
    await client.start();
    await client.openDocument({
      path: fixture.file,
      languageId: "python",
      version: 1,
      text: "😀value = 1\nprint(value)\n",
    });
    await assert.rejects(
      client.updateDocument({
        path: fixture.file,
        version: 1,
        text: "stale",
      }),
      isLspError("stale_document_version"),
    );
    await client.updateDocument({
      path: fixture.file,
      version: 2,
      text: "😀value = 2\nprint(value)\n",
    });
    const state = await client.request<FixtureState>("fixture/state", {});
    assert.equal(state.clientProcessId, process.pid);
    assert.equal(state.documents[0]?.version, 2);
    assert.equal(state.documents[0]?.text.includes("value = 2"), true);

    const controller = new AbortController();
    const blocked = client.request("fixture/block", {}, controller.signal);
    setTimeout(() => controller.abort(new Error("test cancellation")), 20);
    await assert.rejects(blocked, isLspError("request_cancelled"));
    const afterCancellation = await client.request<FixtureState>("fixture/state", {});
    assert.equal(afterCancellation.cancellations.length, 1);

    await assert.rejects(
      client.openDocument({
        path: join(fixture.root, "outside.py"),
        languageId: "python",
        version: 1,
        text: "outside = True\n",
      }),
      isLspError("path_outside_workspace"),
    );
    await client.close();
    await client.close();
    await waitFor(() => existsSync(exitMarker));
    await waitFor(() => !processExists(state.pid));
    assert.equal(JSON.parse(await readFile(exitMarker, "utf8")).shutdownRequested, true);
    assert.deepEqual(client.stats(), {
      starts: 1,
      restarts: 0,
      state: "closed",
      openDocuments: 0,
    });
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client returns typed bounded errors for missing executables, malformed frames, and timeouts", async () => {
  const fixture = workspace("failures");
  const missing = new LspClient({
    command: join(fixture.root, "missing-language-server.exe"),
    workspaceRoot: fixture.workspace,
    requestTimeoutMs: 100,
    restartLimit: 0,
  });
  await assert.rejects(missing.start(), isLspError("spawn_failed"));
  await missing.close();

  const incompatibleEncoding = fixture.client({
    restartLimit: 0,
    env: { LSP_FIXTURE_POSITION_ENCODING: "utf-8" },
  });
  try {
    await assert.rejects(
      incompatibleEncoding.start(),
      isLspError("protocol_error"),
    );
  } finally {
    await incompatibleEncoding.close().catch(() => undefined);
  }

  const malformed = fixture.client({ restartLimit: 0 });
  try {
    await malformed.start();
    await assert.rejects(
      malformed.request("fixture/malformed", {}),
      isLspError("protocol_error"),
    );
  } finally {
    await malformed.close().catch(() => undefined);
  }

  const malformedJson = fixture.client({ restartLimit: 0 });
  try {
    await malformedJson.start();
    await assert.rejects(
      malformedJson.request("fixture/malformedJson", {}),
      isLspError("protocol_error"),
    );
  } finally {
    await malformedJson.close().catch(() => undefined);
  }

  const invalidRpc = fixture.client({ restartLimit: 0 });
  try {
    await invalidRpc.start();
    await assert.rejects(
      invalidRpc.request("fixture/invalidRpc", {}),
      isLspError("protocol_error"),
    );
  } finally {
    await invalidRpc.close().catch(() => undefined);
  }

  const oversized = fixture.client({ restartLimit: 0, maxFrameBytes: 1_024 });
  try {
    await oversized.start();
    await assert.rejects(
      oversized.request("fixture/oversized", {}),
      isLspError("frame_too_large"),
    );
  } finally {
    await oversized.close().catch(() => undefined);
  }

  const timeout = fixture.client({ requestTimeoutMs: 500, restartLimit: 0 });
  try {
    await timeout.start();
    await assert.rejects(
      timeout.request("fixture/block", {}),
      isLspError("request_timeout"),
    );
    const state = await timeout.request<FixtureState>("fixture/state", {});
    assert.equal(state.cancellations.length, 1);
  } finally {
    await timeout.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client settles cancellation before a backpressured pipe and bounds the failed session", async () => {
  const fixture = workspace("stdin backpressure");
  const pauseMarker = join(fixture.root, "stdin-paused.json");
  const descendantMarker = join(fixture.root, "descendant.pid");
  const client = fixture.client({
    requestTimeoutMs: 500,
    writeTimeoutMs: 1_000,
    shutdownTimeoutMs: 250,
    restartLimit: 0,
    maxFrameBytes: 16 * 1024 * 1024,
    env: {
      LSP_FIXTURE_PAUSE_STDIN_FILE: pauseMarker,
      LSP_FIXTURE_DESCENDANT_PID_FILE: descendantMarker,
    },
  });
  let serverPid = 0;
  let descendantPid = 0;
  try {
    await client.start();
    await waitFor(() => existsSync(pauseMarker));
    await waitFor(() => existsSync(descendantMarker));
    serverPid = (JSON.parse(await readFile(pauseMarker, "utf8")) as { pid: number }).pid;
    descendantPid = (JSON.parse(await readFile(descendantMarker, "utf8")) as { pid: number }).pid;

    const settlements: string[] = [];
    const backpressuredWrite = observeSettlement("write", client.openDocument({
      path: fixture.file,
      languageId: "python",
      version: 1,
      text: "x".repeat(8 * 1024 * 1024),
    }), settlements);
    const timedOut = observeSettlement(
      "timeout",
      client.request("fixture/block", {}),
      settlements,
    );
    const controller = new AbortController();
    const aborted = observeSettlement(
      "abort",
      client.request("fixture/block", {}, controller.signal),
      settlements,
    );
    controller.abort();

    await rejectsBefore(aborted, 750, isLspError("request_cancelled"));
    await rejectsBefore(timedOut, 1_250, isLspError("request_timeout"));
    assert.deepEqual(settlements, ["abort", "timeout"]);
    await rejectsBefore(backpressuredWrite, 2_000, isLspError("write_failed"));
    assert.deepEqual(settlements, ["abort", "timeout", "write"]);
    assert.equal(client.stats().state, "failed");
    await completesBefore(client.close(), 1_500);
    await waitFor(() => !processExists(serverPid));
    await waitFor(() => !processExists(descendantPid));
    assert.equal(client.stats().state, "closed");
  } finally {
    await completesBefore(client.close(), 250).catch(() => undefined);
    for (const pid of [serverPid, descendantPid]) {
      if (pid > 0 && processExists(pid)) {
        process.kill(pid, "SIGKILL");
        await waitFor(() => !processExists(pid));
      }
    }
    await completesBefore(client.close(), 500).catch(() => undefined);
    fixture.close();
  }
});

test("LSP client bounds a stalled Windows Job-host bootstrap without an unhandled rejection", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = workspace("stalled job host bootstrap");
  assert.throws(
    () => fixture.client({ windowsJobHostPathForTest: "relative.ps1" }),
    isLspError("invalid_configuration"),
  );
  const pidMarker = join(fixture.root, "stalled-job-host.pid");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const client = new LspClient({
    command: process.execPath,
    args: Array.from(
      { length: 128 },
      (_value, index) => `${index}:`.padEnd(3_500, "x"),
    ),
    workspaceRoot: fixture.workspace,
    env: {
      ...process.env,
      LSP_FIXTURE_STALLED_JOB_HOST_PID_FILE: pidMarker,
    },
    writeTimeoutMs: 1_000,
    shutdownTimeoutMs: 250,
    restartLimit: 0,
    windowsJobHostPathForTest: stalledWindowsJobHost,
  });
  let hostPid = 0;
  try {
    await rejectsBefore(client.start(), 2_000, isLspError("write_failed"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(unhandled, []);
    await waitFor(() => existsSync(pidMarker));
    hostPid = Number(await readFile(pidMarker, "utf8"));
    assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0);
    await completesBefore(client.close(), 1_000);
    await waitFor(() => !processExists(hostPid));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await completesBefore(client.close(), 500).catch(() => undefined);
    if (hostPid > 0 && processExists(hostPid)) {
      process.kill(hostPid, "SIGKILL");
      await waitFor(() => !processExists(hostPid));
    }
    fixture.close();
  }
});

test("LSP client launches a safe Windows command-shell shim through the Job Object host", async () => {
  const fixture = workspace("cmd launcher");
  const shim = join(fixture.root, "fixture-language-server.cmd");
  writeFileSync(
    shim,
    `@echo off\r\n"${process.execPath}" "${fixtureServer}" %*\r\n`,
  );
  const client = new LspClient({
    command: shim,
    workspaceRoot: fixture.workspace,
    requestTimeoutMs: 3_000,
    shutdownTimeoutMs: 500,
    restartLimit: 0,
    env: { ...process.env },
  });
  try {
    await client.start();
    const state = await client.request<FixtureState>("fixture/state", {});
    assert.equal(state.rootUri, pathToFileURL(fixture.workspace).href);
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client launches a direct executable in a space and Unicode workspace", async () => {
  const fixture = workspace("space Ω launch");
  const client = fixture.client();
  try {
    await client.start();
    const state = await client.request<FixtureState>("fixture/state", {});
    assert.equal(state.rootUri, pathToFileURL(fixture.workspace).href);
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client launches the attested canonical executable and rejects a byte replacement before spawn", async () => {
  const fixture = workspace("attested executable Ω");
  const commandName = process.platform === "win32" ? "fixture-lsp.cmd" : "fixture-lsp";
  const launcher = join(fixture.root, commandName);
  const commandSource = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixtureServer}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixtureServer}" "$@"\n`;
  writeFileSync(launcher, commandSource);
  if (process.platform !== "win32") {
    chmodSync(launcher, 0o755);
  }
  const resolvedEnvironment = { ...process.env };
  const identity = await resolveLanguageServerExecutable(launcher, {
    commandSearchDirectory: fixture.root,
    environment: resolvedEnvironment,
  });
  const client = new LspClient({
    command: identity.path,
    attestedCommand: identity,
    workspaceRoot: fixture.workspace,
    requestTimeoutMs: 3_000,
    shutdownTimeoutMs: 500,
    restartLimit: 0,
    env: resolvedEnvironment,
  });
  try {
    await client.start();
    const state = await client.request<FixtureState>("fixture/state", {});
    assert.equal(state.rootUri, pathToFileURL(fixture.workspace).href);
    await client.close();

    const replaced = new LspClient({
      command: identity.path,
      attestedCommand: identity,
      workspaceRoot: fixture.workspace,
      requestTimeoutMs: 500,
      restartLimit: 0,
      env: resolvedEnvironment,
    });
    writeFileSync(launcher, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") chmodSync(launcher, 0o755);
    await assert.rejects(replaced.start(), isLspError("invalid_configuration"));
    assert.equal(replaced.stats().starts, 0, "a replaced launcher must be rejected before process creation");
    await replaced.close();
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client cannot bypass the restart limit through an explicit start", async () => {
  const fixture = workspace("restart-limit");
  const client = fixture.client({ restartLimit: 0 });
  try {
    await client.start();
    await assert.rejects(
      client.request("fixture/crash", {}),
      isLspError("process_exited"),
    );
    await assert.rejects(client.start(), isLspError("process_exited"));
    assert.equal(client.stats().starts, 1);
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client force-closes a server that does not answer shutdown", async () => {
  const fixture = workspace("forced-shutdown");
  const client = fixture.client({
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    env: {
      LSP_FIXTURE_IGNORE_SHUTDOWN: "1",
    },
  });
  try {
    await client.start();
    const state = await client.request<FixtureState>("fixture/state", {});
    await client.close();
    await waitFor(() => !processExists(state.pid));
    assert.equal(client.stats().state, "closed");
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client retries termination after a failed close while the server remains live", async () => {
  const fixture = workspace("close termination retry");
  let terminationAttempts = 0;
  const client = fixture.client({
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 100,
    env: { LSP_FIXTURE_IGNORE_SHUTDOWN: "1" },
    processTreeTerminationHook: async (terminate: () => Promise<void>) => {
      terminationAttempts += 1;
      if (terminationAttempts === 1) {
        throw new Error("injected process-tree termination failure");
      }
      await terminate();
    },
  });
  let pid = 0;
  try {
    await client.start();
    pid = (await client.request<FixtureState>("fixture/state", {})).pid;
    await assert.rejects(client.close(), /injected process-tree termination failure/i);
    assert.equal(processExists(pid), true);

    await client.close();
    await waitFor(() => !processExists(pid));
    assert.equal(terminationAttempts, 2);
    assert.equal(client.stats().state, "closed");
  } finally {
    await client.close().catch(() => undefined);
    if (pid > 0 && processExists(pid)) {
      process.kill(pid, "SIGKILL");
      await waitFor(() => !processExists(pid));
    }
    fixture.close();
  }
});

test("LSP client retains a fast versionless publish as explicitly non-authoritative", async () => {
  const fixture = workspace("versionless publish diagnostics");
  const client = fixture.client({
    publishDiagnosticsWaitTimeoutMs: 80,
    env: {
      LSP_FIXTURE_DIAGNOSTICS_MODE: "push",
      LSP_FIXTURE_PUBLISH_WITHOUT_VERSION: "1",
      LSP_FIXTURE_DIAGNOSTIC_VERSION_MARKERS: "1",
    },
  });
  const uri = client.documentUri(fixture.file);
  try {
    await client.openDocument({
      path: fixture.file,
      languageId: "python",
      version: 1,
      text: "value = 1\n",
    });
    await client.request("fixture/diagnosticBarrier", {});
    const published = client.publishedDiagnostics(uri);
    assert.equal(published?.version, undefined);
    assert.equal(published?.unversioned, true);
    assert.match(String(published?.diagnostics[0] && (published.diagnostics[0] as { message?: unknown }).message), /v1$/);
    assert.equal(await client.waitForPublishedDiagnostics(uri, 1), undefined);
    assert.equal(client.publishedDiagnosticsForOpenDocuments()[0]?.unversioned, true);
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client never relabels delayed versionless v1 diagnostics as authoritative v2", async () => {
  const fixture = workspace("versionless stale diagnostics");
  const client = fixture.client({
    publishDiagnosticsWaitTimeoutMs: 80,
    env: {
      LSP_FIXTURE_DIAGNOSTICS_MODE: "push",
      LSP_FIXTURE_PUBLISH_WITHOUT_VERSION: "1",
      LSP_FIXTURE_DELAY_VERSIONLESS_VERSION: "1",
      LSP_FIXTURE_DELAY_VERSIONLESS_MS: "40",
      LSP_FIXTURE_DIAGNOSTIC_VERSION_MARKERS: "1",
    },
  });
  const uri = client.documentUri(fixture.file);
  try {
    await client.openDocument({
      path: fixture.file,
      languageId: "python",
      version: 1,
      text: "value = 1\n",
    });
    await client.updateDocument({
      path: fixture.file,
      version: 2,
      text: "value = 2\n",
    });
    await client.request("fixture/diagnosticBarrier", {});
    const published = client.publishedDiagnostics(uri);
    assert.equal(published?.version, undefined);
    assert.equal(published?.unversioned, true);
    assert.match(String(published?.diagnostics[0] && (published.diagnostics[0] as { message?: unknown }).message), /v1$/);
    assert.equal(await client.waitForPublishedDiagnostics(uri, 2), undefined);
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client rejects an explicit stale publish after an explicitly versioned current result", async () => {
  const fixture = workspace("explicit stale diagnostics");
  const client = fixture.client({
    publishDiagnosticsWaitTimeoutMs: 80,
    env: {
      LSP_FIXTURE_DIAGNOSTICS_MODE: "push",
      LSP_FIXTURE_PUBLISH_STALE_VERSION: "1",
      LSP_FIXTURE_PUBLISH_STALE_AFTER_VERSION: "2",
      LSP_FIXTURE_DIAGNOSTIC_VERSION_MARKERS: "1",
    },
  });
  const uri = client.documentUri(fixture.file);
  try {
    await client.openDocument({
      path: fixture.file,
      languageId: "python",
      version: 1,
      text: "value = 1\n",
    });
    await client.request("fixture/diagnosticBarrier", {});
    assert.equal(client.publishedDiagnostics(uri)?.version, 1);
    assert.equal(client.publishedDiagnostics(uri)?.unversioned, undefined);

    await client.updateDocument({
      path: fixture.file,
      version: 2,
      text: "value = 2\n",
    });
    await client.request("fixture/diagnosticBarrier", {});
    assert.equal(client.publishedDiagnostics(uri), undefined);
    assert.equal(await client.waitForPublishedDiagnostics(uri, 2), undefined);
  } finally {
    await client.close().catch(() => undefined);
    fixture.close();
  }
});

test("LSP client shutdown owns and terminates language-server descendants", async () => {
  const fixture = workspace("descendant Ω");
  const descendantMarker = join(fixture.root, "descendant.pid");
  const client = fixture.client({
    env: { LSP_FIXTURE_DESCENDANT_PID_FILE: descendantMarker },
  });
  let descendantPid = 0;
  try {
    await client.start();
    await waitFor(() => existsSync(descendantMarker));
    const descendant = JSON.parse(await readFile(descendantMarker, "utf8")) as {
      pid: number;
      parentPid: number;
    };
    descendantPid = descendant.pid;
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    const state = await client.request<FixtureState>("fixture/state", {});
    assert.equal(descendant.parentPid, state.pid);
    await client.close();
    await waitFor(() => !processExists(descendantPid));
  } finally {
    await client.close().catch(() => undefined);
    if (descendantPid > 0 && processExists(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
      await waitFor(() => !processExists(descendantPid));
    }
    fixture.close();
  }
});

test("LSP client restarts a crashed server only within the configured limit and reopens documents", async () => {
  const fixture = workspace("restart");
  const crashMarker = join(fixture.root, "crashed-once.txt");
  const recovered = fixture.client({
    restartLimit: 1,
    env: { LSP_FIXTURE_CRASH_ONCE_FILE: crashMarker },
  });
  try {
    await recovered.start();
    await recovered.openDocument({
      path: fixture.file,
      languageId: "python",
      version: 7,
      text: "value = 7\n",
    });
    const result = await recovered.request<{ recovered: boolean }>("fixture/crashOnce", {});
    assert.equal(result.recovered, true);
    assert.deepEqual(recovered.stats(), {
      starts: 2,
      restarts: 1,
      state: "running",
      openDocuments: 1,
    });
    const state = await recovered.request<FixtureState>("fixture/state", {});
    assert.equal(state.documents[0]?.version, 7);
    assert.equal(state.documents[0]?.text, "value = 7\n");
  } finally {
    await recovered.close().catch(() => undefined);
  }

  const exhausted = fixture.client({ restartLimit: 1 });
  try {
    await exhausted.start();
    await assert.rejects(
      exhausted.request("fixture/crash", {}),
      isLspError("process_exited"),
    );
    assert.equal(exhausted.stats().restarts, 1);
  } finally {
    await exhausted.close().catch(() => undefined);
    fixture.close();
  }
});

interface FixtureState {
  pid: number;
  clientProcessId: number | null;
  rootUri: string;
  documents: Array<{ uri: string; version: number; text: string }>;
  cancellations: Array<number | string>;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function workspace(name: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-lsp-${name}-`));
  const workspacePath = join(root, "workspace Ω");
  mkdirSync(workspacePath);
  const file = join(workspacePath, "main.py");
  writeFileSync(file, "😀value = 1\nprint(value)\n");
  return {
    root,
    workspace: workspacePath,
    file,
    client(overrides: Partial<ConstructorParameters<typeof LspClient>[0]> = {}) {
      return new LspClient({
        command: process.execPath,
        args: [fixtureServer],
        workspaceRoot: workspacePath,
        requestTimeoutMs: 500,
        shutdownTimeoutMs: 500,
        restartLimit: 1,
        ...overrides,
        env: {
          ...process.env,
          ...overrides.env,
        },
      });
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function isLspError(code: string) {
  return (error: unknown) => error instanceof LspClientError && error.code === code;
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fixture state.");
}

async function rejectsBefore(
  promise: Promise<unknown>,
  deadlineMs: number,
  predicate: (error: unknown) => boolean,
): Promise<void> {
  await assert.rejects(completesBefore(promise, deadlineMs), predicate);
}

function observeSettlement<T>(
  label: string,
  promise: Promise<T>,
  settlements: string[],
): Promise<T> {
  return promise.finally(() => settlements.push(label));
}

async function completesBefore<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Operation did not settle within ${deadlineMs} ms.`)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
