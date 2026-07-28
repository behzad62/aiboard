/* Account-runner stream cleanup regression (run: npx tsx scripts/test-account-runner-stream-cleanup.mts) */
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAccountRunnerProvider } from "../lib/providers/account-runner";

let requestClosed = false;
let notifyRequestClosed!: () => void;
const requestCloseObserved = new Promise<void>((resolve) => {
  notifyRequestClosed = resolve;
});

const server = http.createServer((_request, response) => {
  const observeClose = () => {
    requestClosed = true;
    notifyRequestClosed();
  };
  response.socket?.once("close", observeClose);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({ type: "token", content: "one" })}\n\n`);
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address() as AddressInfo;
const provider = createAccountRunnerProvider({
  id: "chatgpt",
  name: "ChatGPT Plus/Pro",
  runnerPath: "chatgpt",
  models: [],
});
const iterator = provider
  .streamChat({
    apiKey: "runner-token",
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "Return one token, then stall." }],
    baseURL: `http://127.0.0.1:${address.port}`,
  })
  [Symbol.asyncIterator]();

try {
  const first = await iterator.next();
  assert.deepEqual(first, {
    done: false,
    value: { type: "token", content: "one" },
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await iterator.return?.();
        await requestCloseObserved;
      })(),
      new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Timed out waiting for account-runner request closure.")),
          2_000
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  assert.equal(requestClosed, true);
  console.log("PASS");
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}
