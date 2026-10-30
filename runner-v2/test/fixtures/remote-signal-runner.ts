import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";

import { startRunner } from "../../src/runner-start.js";
import type { RemoteSessionIssuer } from "../../src/remote-auth.js";
import { FixtureWebSocketTransport } from "./remote-fake-relay.js";

// Test child: the same Runner start and SIGINT/SIGTERM handling as the CLI,
// with the relay duplex on the inherited IPC pipe, a test session issuer,
// and no loopback control listener. Authentication is exactly production's;
// only the transport and provisioning source are injected.
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index]!, process.argv[index + 1]!);
}
const required = (name: string): string => {
  const value = args.get(name);
  if (!value) throw new Error(`remote-signal-runner requires ${name}.`);
  return value;
};

const certificate = readFileSync(required("--relay-cert"), "utf8");
const session = JSON.parse(readFileSync(required("--session-file"), "utf8")) as Awaited<ReturnType<RemoteSessionIssuer["restoreSession"]>>;
const issuer: RemoteSessionIssuer = {
  pairingUrl: "https://mcp.aiboard.me/pair",
  restoreSession: async () => session,
  requestSession: async () => { throw new Error("unauthorized: test child has no pairing flow."); },
};
// The inherited Node IPC pipe is the child byte channel: each message is one
// chunk of the same TLS/WebSocket stream the in-memory pair carries.
class ChildIpcDuplex extends Duplex {
  constructor() {
    super();
    process.on("message", (message: unknown) => {
      if (Buffer.isBuffer(message)) this.push(message);
      else if (message instanceof Uint8Array) this.push(Buffer.from(message));
    });
  }

  _read(): void { /* The parent pushes chunks as IPC messages. */ }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!process.send) return callback(new Error("Inherited relay pipe is unavailable."));
    process.send(chunk, (error) => callback(error ?? null));
  }

  // The pipe lives exactly as long as the relay stream: when the Runner
  // closes its transport the channel is released, so a Runner that never
  // closes its transport never exits.
  _final(callback: (error?: Error | null) => void): void {
    if (process.connected) process.disconnect?.();
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (process.connected) process.disconnect?.();
    callback(error);
  }
}
const transport = new FixtureWebSocketTransport(new ChildIpcDuplex(), certificate);

const started = await startRunner([
  "--project", required("--project"),
  "--state-dir", required("--state-dir"),
  "--extensions-home", required("--extensions-home"),
  "--remote",
  "--remote-device-dir", required("--device-dir"),
], {
  createTransport: () => transport,
  issuer,
  controlListener: "none",
});
if (!started.started) process.exitCode = 1;
// Windows has no way to raise SIGINT in a console-less child (child.kill
// is TerminateProcess), so the parent asks over the pipe and the child runs
// the exact handler startRunner registered for SIGINT. POSIX sends the
// real signal instead.
process.on("message", (message: unknown) => {
  if (typeof message === "object" && message !== null && !(message instanceof Uint8Array)
    && (message as { type?: unknown }).type === "aiboard-test-sigint") void started.shutdown("SIGINT");
});
