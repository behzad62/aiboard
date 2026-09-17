import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

let input = Buffer.alloc(0);
let rootUri = "";
let clientProcessId = null;
let shutdownRequested = false;
let outputQueue = Promise.resolve();
const pendingDiagnosticPublications = new Set();
const heldDiagnosticPublications = new Map();
const documents = new Map();
const cancellations = [];
const blocked = new Set();
const requests = [];

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  drainInput();
});
process.stdin.on("end", () => process.exit(shutdownRequested ? 0 : 1));
process.on("SIGTERM", () => {
  // The descendant fixture deliberately keeps the root alive long enough for
  // the client test to observe whether it terminated the complete tree.
  if (process.env.LSP_FIXTURE_DESCENDANT_PID_FILE) return;
  process.exit(143);
});
process.on("exit", (code) => {
  const markerArgument = process.argv.indexOf("--fixture-exit-file");
  const marker = process.env.LSP_FIXTURE_EXIT_FILE ||
    (markerArgument >= 0 ? process.argv[markerArgument + 1] : undefined);
  if (marker) {
    try {
      writeFileSync(marker, JSON.stringify({ code, shutdownRequested, pid: process.pid }));
    } catch {}
  }
});

function drainInput() {
  while (true) {
    const boundary = input.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const header = input.subarray(0, boundary).toString("ascii");
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
    if (!match) process.exit(70);
    const length = Number(match[1]);
    const frameEnd = boundary + 4 + length;
    if (input.length < frameEnd) return;
    const body = input.subarray(boundary + 4, frameEnd).toString("utf8");
    input = input.subarray(frameEnd);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      process.exit(71);
    }
    void handle(message);
  }
}

async function handle(message) {
  const method = typeof message.method === "string" ? message.method : undefined;
  if (!method) return;
  requests.push(method);
  if (method === "initialize") {
    rootUri = message.params?.rootUri ?? "";
    clientProcessId = message.params?.processId ?? null;
    writeRootMarker();
    startDescendantFixture();
    await respond(message.id, {
      capabilities: {
        ...(process.env.LSP_FIXTURE_POSITION_ENCODING
          ? { positionEncoding: process.env.LSP_FIXTURE_POSITION_ENCODING }
          : {}),
        textDocumentSync: { openClose: true, change: 1 },
        definitionProvider: true,
        referencesProvider: true,
        workspaceSymbolProvider: true,
        ...(process.env.LSP_FIXTURE_DIAGNOSTICS_MODE === "push"
          ? {}
          : {
              diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics:
                  process.env.LSP_FIXTURE_DIAGNOSTICS_MODE !== "partial",
              },
            }),
      },
      serverInfo: { name: "aiboard-lsp-fixture", version: "1" },
    });
    return;
  }
  if (method === "initialized") {
    const pauseMarker = process.env.LSP_FIXTURE_PAUSE_STDIN_FILE;
    if (pauseMarker) {
      process.stdin.pause();
      // Pausing the only referenced input handle otherwise lets Node exit;
      // this fixture must remain alive to exercise a genuinely blocked pipe.
      setInterval(() => {}, 1000);
      writeFileSync(pauseMarker, JSON.stringify({ pid: process.pid }));
    }
    return;
  }
  if (method === "shutdown") {
    shutdownRequested = true;
    if (process.env.LSP_FIXTURE_IGNORE_SHUTDOWN === "1") return;
    await respond(message.id, null);
    return;
  }
  if (method === "exit") {
    await outputQueue;
    if (process.env.LSP_FIXTURE_DESCENDANT_PID_FILE) {
      await delay(400);
    }
    process.exit(shutdownRequested ? 0 : 1);
  }
  if (method === "textDocument/didOpen") {
    const document = message.params?.textDocument;
    documents.set(document.uri, {
      version: document.version,
      text: document.text,
      languageId: document.languageId,
    });
    await queuePublishDiagnostics(document.uri, document.version);
    return;
  }
  if (method === "textDocument/didChange") {
    const document = message.params?.textDocument;
    const current = documents.get(document.uri);
    const text = message.params?.contentChanges?.[0]?.text;
    if (!current || !Number.isSafeInteger(document.version) ||
        document.version <= current.version || typeof text !== "string") {
      await notify("window/logMessage", {
        type: 1,
        message: "stale document version",
      });
      return;
    }
    documents.set(document.uri, { ...current, version: document.version, text });
    await queuePublishDiagnostics(document.uri, document.version);
    return;
  }
  if (method === "textDocument/didClose") {
    documents.delete(message.params?.textDocument?.uri);
    return;
  }
  if (method === "$/cancelRequest") {
    cancellations.push(message.params?.id);
    const id = message.params?.id;
    blocked.delete(id);
    if (process.env.LSP_FIXTURE_CANCEL_RESPONSE === "1") {
      await respondError(id, -32800, "Request cancelled");
    }
    return;
  }
  if (method === "workspace/symbol") {
    const uri = firstDocumentUri();
    await respond(message.id, [{
      name: "value",
      kind: 13,
      location: { uri, range: range(0, 2, 0, 7) },
    }]);
    return;
  }
  if (method === "textDocument/definition") {
    if (!(await verifyExpectedCharacter(message))) return;
    await respond(message.id, {
      uri: process.env.LSP_FIXTURE_OUTSIDE_URI || message.params.textDocument.uri,
      range: process.env.LSP_FIXTURE_BAD_RANGE === "1"
        ? range(0, 2, 999, 7)
        : range(0, 2, 0, 7),
    });
    return;
  }
  if (method === "textDocument/references") {
    if (!(await verifyExpectedCharacter(message))) return;
    const uri = message.params.textDocument.uri;
    await respond(message.id, [
      { uri, range: range(0, 2, 0, 7) },
      { uri, range: range(1, 6, 1, 11) },
    ]);
    return;
  }
  if (method === "textDocument/diagnostic") {
    if (process.env.LSP_FIXTURE_DIAGNOSTICS_MODE === "push") {
      await respondError(message.id, -32601, "Pull diagnostics are disabled.");
      return;
    }
    await respond(message.id, {
      kind: "full",
      items: diagnostics(message.params.textDocument.uri),
    });
    return;
  }
  if (method === "workspace/diagnostic") {
    if (process.env.LSP_FIXTURE_DIAGNOSTICS_MODE === "push" ||
        process.env.LSP_FIXTURE_DIAGNOSTICS_MODE === "partial") {
      await respondError(message.id, -32601, "Workspace pull diagnostics are disabled.");
      return;
    }
    await respond(message.id, {
      items: [...documents.keys()].map((uri) => ({
        uri,
        kind: "full",
        items: diagnostics(uri),
      })),
    });
    return;
  }
  if (method === "fixture/state") {
    await respond(message.id, {
      pid: process.pid,
      clientProcessId,
      rootUri,
      documents: [...documents.entries()].map(([uri, value]) => ({ uri, ...value })),
      cancellations: [...cancellations],
      requests: [...requests],
    });
    return;
  }
  if (method === "fixture/diagnosticBarrier") {
    await Promise.all([...pendingDiagnosticPublications]);
    await respond(message.id, { published: true });
    return;
  }
  if (method === "fixture/block") {
    blocked.add(message.id);
    const marker = process.env.LSP_FIXTURE_BLOCK_RECEIVED_FILE;
    if (marker) {
      writeFileSync(marker + ".tmp", JSON.stringify({ pid: process.pid, requestId: message.id }));
      renameSync(marker + ".tmp", marker);
    }
    return;
  }
  if (method === "fixture/malformed") {
    process.stdout.write("Content-Length: nope\r\n\r\n{}");
    return;
  }
  if (method === "fixture/malformedJson") {
    process.stdout.write("Content-Length: 4\r\n\r\n{bad");
    return;
  }
  if (method === "fixture/invalidRpc") {
    await send({ unexpected: true });
    return;
  }
  if (method === "fixture/oversized") {
    process.stdout.write("Content-Length: 99999999\r\n\r\n");
    return;
  }
  if (method === "fixture/crashOnce") {
    const marker = process.env.LSP_FIXTURE_CRASH_ONCE_FILE;
    if (marker && !existsSync(marker)) {
      writeFileSync(marker, String(process.pid));
      process.exit(86);
    }
    await respond(message.id, { recovered: true, pid: process.pid });
    return;
  }
  if (method === "fixture/crash") process.exit(87);
  await respondError(message.id, -32601, `Unknown fixture method ${method}`);
}

function writeRootMarker() {
  const rootArgument = process.argv.indexOf("--fixture-root-log");
  const rootLog = rootArgument >= 0 ? process.argv[rootArgument + 1] : undefined;
  if (!rootLog) return;
  try {
    appendFileSync(rootLog, `${JSON.stringify({ rootUri, pid: process.pid })}\n`);
  } catch {}
}

function startDescendantFixture() {
  const marker = process.env.LSP_FIXTURE_DESCENDANT_PID_FILE;
  if (!marker) return;
  try {
    const descendant = spawn(process.execPath, ["-e", [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.LSP_FIXTURE_DESCENDANT_PID_FILE, JSON.stringify({ pid: process.pid, parentPid: process.ppid }));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("")], {
      // Windows Job ownership includes detached children; POSIX group ownership
      // covers descendants that do not deliberately escape with setsid.
      detached: process.platform === "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    descendant.unref();
  } catch {}
}

async function verifyExpectedCharacter(message) {
  const expected = process.env.LSP_FIXTURE_EXPECT_CHARACTER;
  if (expected !== undefined && message.params?.position?.character !== Number(expected)) {
    await respondError(
      message.id,
      -32001,
      `Expected UTF-16 character ${expected}; received ${message.params?.position?.character}`,
    );
    return false;
  }
  return true;
}

function firstDocumentUri() {
  return documents.keys().next().value ?? new URL("main.py", `${rootUri.replace(/\/?$/, "/")}`).href;
}

function diagnostics(uri, version) {
  const count = Number(process.env.LSP_FIXTURE_DIAGNOSTIC_COUNT ?? "1");
  const versionSuffix = process.env.LSP_FIXTURE_DIAGNOSTIC_VERSION_MARKERS === "1"
    ? ` v${version}`
    : "";
  return Array.from({ length: Number.isSafeInteger(count) && count > 0 ? count : 1 }, (_value, index) => ({
    range: range(1, 0, 1, 5),
    severity: 2,
    code: index === 0 ? "fixture-warning" : `fixture-warning-${index + 1}`,
    source: "fixture",
    message: `Fixture diagnostic for ${uri}${versionSuffix}`,
  }));
}

async function publishDiagnostics(uri, version) {
  const staleAfterVersion = Number(process.env.LSP_FIXTURE_PUBLISH_STALE_AFTER_VERSION ?? "0");
  const publishStaleVersion = process.env.LSP_FIXTURE_PUBLISH_STALE_VERSION === "1" &&
    (!Number.isSafeInteger(staleAfterVersion) || staleAfterVersion <= 0 || version >= staleAfterVersion);
  await notify("textDocument/publishDiagnostics", {
    uri,
    ...(process.env.LSP_FIXTURE_PUBLISH_WITHOUT_VERSION === "1"
      ? {}
      : {
          version: publishStaleVersion
            ? Math.max(0, version - 1)
            : version,
        }),
    diagnostics: diagnostics(uri, version),
  });
  if (process.env.LSP_FIXTURE_PUBLISH_OUT_OF_ORDER_STALE_VERSION === "1") {
    await notify("textDocument/publishDiagnostics", {
      uri,
      version: Math.max(0, version - 1),
      diagnostics: diagnostics(uri, version),
    });
  }
}

function queuePublishDiagnostics(uri, version) {
  const delayedVersion = Number(process.env.LSP_FIXTURE_DELAY_VERSIONLESS_VERSION ?? "0");
  const delayMs = Number(process.env.LSP_FIXTURE_DELAY_VERSIONLESS_MS ?? "0");
  const holdUntilVersion = Number(process.env.LSP_FIXTURE_HOLD_VERSIONLESS_UNTIL_VERSION ?? "0");
  const task = (async () => {
    // Causal test schedule: the delayed old report is emitted only after the
    // explicitly requested newer report, independent of host transport speed.
    if (process.env.LSP_FIXTURE_PUBLISH_WITHOUT_VERSION === "1" && version === delayedVersion && holdUntilVersion > version) {
      await new Promise((resolve) => heldDiagnosticPublications.set(uri, { version: holdUntilVersion, resolve }));
    }
    if (
      process.env.LSP_FIXTURE_PUBLISH_WITHOUT_VERSION === "1" &&
      version === delayedVersion &&
      Number.isFinite(delayMs) &&
      delayMs > 0
    ) {
      await delay(delayMs);
    }
    await publishDiagnostics(uri, version);
    const pending = heldDiagnosticPublications.get(uri);
    if (pending && version >= pending.version) { heldDiagnosticPublications.delete(uri); pending.resolve(); }
  })();
  pendingDiagnosticPublications.add(task);
  void task.finally(() => pendingDiagnosticPublications.delete(task));
  return task;
}

function range(startLine, startCharacter, endLine, endCharacter) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

async function respond(id, result) {
  await send({ jsonrpc: "2.0", id, result });
}

async function respondError(id, code, message) {
  await send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function notify(method, params) {
  await send({ jsonrpc: "2.0", method, params });
}

async function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
    body,
  ]);
  outputQueue = outputQueue.then(async () => {
    if (process.env.LSP_FIXTURE_PARTIAL !== "1") {
      process.stdout.write(frame);
      return;
    }
    const first = Math.min(7, frame.length);
    const second = Math.min(first + 11, frame.length);
    process.stdout.write(frame.subarray(0, first));
    await delay(2);
    process.stdout.write(frame.subarray(first, second));
    await delay(2);
    process.stdout.write(frame.subarray(second));
  });
  await outputQueue;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
