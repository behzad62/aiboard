import { existsSync, writeFileSync } from "node:fs";

let input = Buffer.alloc(0);
let rootUri = "";
let clientProcessId = null;
let shutdownRequested = false;
let outputQueue = Promise.resolve();
const documents = new Map();
const cancellations = [];
const blocked = new Set();

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  drainInput();
});
process.stdin.on("end", () => process.exit(shutdownRequested ? 0 : 1));
process.on("SIGTERM", () => process.exit(143));
process.on("exit", (code) => {
  const marker = process.env.LSP_FIXTURE_EXIT_FILE;
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
  if (method === "initialize") {
    rootUri = message.params?.rootUri ?? "";
    clientProcessId = message.params?.processId ?? null;
    await respond(message.id, {
      capabilities: {
        ...(process.env.LSP_FIXTURE_POSITION_ENCODING
          ? { positionEncoding: process.env.LSP_FIXTURE_POSITION_ENCODING }
          : {}),
        textDocumentSync: { openClose: true, change: 1 },
        definitionProvider: true,
        referencesProvider: true,
        workspaceSymbolProvider: true,
        diagnosticProvider: {
          interFileDependencies: false,
          workspaceDiagnostics: true,
        },
      },
      serverInfo: { name: "aiboard-lsp-fixture", version: "1" },
    });
    return;
  }
  if (method === "initialized") return;
  if (method === "shutdown") {
    shutdownRequested = true;
    if (process.env.LSP_FIXTURE_IGNORE_SHUTDOWN === "1") return;
    await respond(message.id, null);
    return;
  }
  if (method === "exit") {
    await outputQueue;
    process.exit(shutdownRequested ? 0 : 1);
  }
  if (method === "textDocument/didOpen") {
    const document = message.params?.textDocument;
    documents.set(document.uri, {
      version: document.version,
      text: document.text,
      languageId: document.languageId,
    });
    await publishDiagnostics(document.uri, document.version);
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
    await publishDiagnostics(document.uri, document.version);
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
    await respond(message.id, {
      kind: "full",
      items: diagnostics(message.params.textDocument.uri),
    });
    return;
  }
  if (method === "workspace/diagnostic") {
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
    });
    return;
  }
  if (method === "fixture/block") {
    blocked.add(message.id);
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

function diagnostics(uri) {
  return [{
    range: range(1, 0, 1, 5),
    severity: 2,
    code: "fixture-warning",
    source: "fixture",
    message: `Fixture diagnostic for ${uri}`,
  }];
}

async function publishDiagnostics(uri, version) {
  await notify("textDocument/publishDiagnostics", {
    uri,
    version,
    diagnostics: diagnostics(uri),
  });
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
