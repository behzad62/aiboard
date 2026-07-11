import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountRunnerModel, ProviderTransportError } from "../src/account-runner-model.js";
import { EncryptedProviderConfigStore } from "../src/encrypted-provider-config-store.js";

test("provider configuration is encrypted at rest and rejects the wrong runner token", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-provider-config-"));
  const path = join(root, "providers.enc");
  try {
    let store = new EncryptedProviderConfigStore(path, "runner-token-secret");
    store.save([
      {
        runtimeId: "chatgpt:gpt-5.5",
        providerId: "chatgpt",
        modelId: "gpt-5.5",
        transport: "account-runner",
        baseUrl: "http://127.0.0.1:1455",
        secret: "account-runner-secret",
        capabilities: ["code"],
        priority: 1,
      },
    ]);
    store.close();
    const bytes = readFileSync(path);
    assert.equal(bytes.includes(Buffer.from("account-runner-secret")), false);
    assert.equal(bytes.includes(Buffer.from("gpt-5.5")), false);

    store = new EncryptedProviderConfigStore(path, "runner-token-secret");
    assert.equal(store.load()[0].secret, "account-runner-secret");
    store.close();
    assert.throws(
      () => new EncryptedProviderConfigStore(path, "wrong-runner-token-secret").load(),
      /decrypt provider configuration/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account runner transport maps native tool calls, usage, and tool results", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      type: "tool_call",
      toolCall: { id: "call_1", name: "fs_read", arguments: { path: "a.txt" } },
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 3 },
    })}\n\n`);
    response.end(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.5",
    });
    const turn = await model.complete({
      sessionId: "session_1",
      messages: [
        { id: "system", role: "system", content: "Use tools." },
        {
          id: "tool",
          role: "tool",
          content: {
            callId: "prior",
            toolName: "fs.read",
            content: [{ type: "text", text: "contents" }],
            isError: false,
          },
        },
      ],
      tools: [
        {
          name: "fs.read",
          description: "Read",
          inputSchema: { type: "object" },
          readOnly: true,
          effect: "none",
        },
      ],
    });
    assert.equal(turn.stopReason, "tool_calls");
    assert.deepEqual(turn.blocks[0], {
      type: "tool_call",
      callId: "call_1",
      name: "fs.read",
      arguments: { path: "a.txt" },
    });
    assert.deepEqual(turn.usage, { inputTokens: 12, outputTokens: 3 });
    assert.match(JSON.stringify(requests[0]), /TOOL_RESULT/);
    assert.equal((requests[0].nativeTools as unknown[]).length, 1);
    assert.equal(
      (requests[0].nativeTools as Array<{ name: string }>)[0].name,
      "fs_read"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("account runner HTTP failures preserve status for provider routing", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    response.end(JSON.stringify({ error: "The usage limit has been reached" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = new AccountRunnerModel({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runnerPath: "chatgpt",
      runnerToken: "local-token",
      modelId: "gpt-5.5",
    });
    await assert.rejects(
      () => model.complete({ sessionId: "s", messages: [], tools: [] }),
      (error: unknown) =>
        error instanceof ProviderTransportError &&
        error.status === 429 &&
        error.retryAfterMs === 60_000
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
