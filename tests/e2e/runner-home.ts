/**
 * A real Runner for e2e tests: ControlServer + ModelProxy + an AIBoard home in a temp folder,
 * paired with the page the way `aiboard`'s link would pair it (HM4a, HM4b). Provider calls go
 * through the proxy to a stub upstream on loopback; stub keys only, never a live provider.
 */
import type { BrowserContext } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAiboardHome, type AiboardHomeLocation } from "../../runner-v2/src/aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHomeSync, type HomeOp } from "../../runner-v2/src/aiboard-home-store.js";
import { ControlServer } from "../../runner-v2/src/control-server.js";
import { HomeBackedProviderConfigStore } from "../../runner-v2/src/home-provider-configs.js";
import { createLocalPairTicket, LocalPairing } from "../../runner-v2/src/local-pairing.js";
import { ModelProxy } from "../../runner-v2/src/model-proxy.js";
import { SqlitePermissionStore } from "../../runner-v2/src/permission-store.js";
import { validateProviderConfigs, type ProviderConfigStore, type RunnerProviderConfig } from "../../runner-v2/src/provider-config-store.js";
import { RunSupervisor } from "../../runner-v2/src/run-supervisor.js";
import { SqliteEventStore } from "../../runner-v2/src/sqlite-event-store.js";

export type { HomeOp };
export { readAiboardHomeSync };

const CONTROL_TOKEN = "runner-home-e2e-control-token";
export const RUNNER_INSTANCE = "runner-home-e2e";

export type ToolBench = ConstructorParameters<typeof ControlServer>[0]["toolBench"];

export interface RunnerHome {
  root: string;
  location: AiboardHomeLocation;
  url: string;
  port: number;
  /** The page's launcher session token (as the pairing link leaves it). */
  sessionToken: string;
  permissions: SqlitePermissionStore;
  close(): Promise<void>;
}

/** Starts a Runner whose home already holds `ops` (applied as one batch at revision 0). */
export async function startRunnerHome(options: { ops?: HomeOp[]; toolBench?: ToolBench } = {}): Promise<RunnerHome> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-runner-home-e2e-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const location = resolveAiboardHome({
    platform: process.platform,
    environment: { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") },
    home: userHome,
  });
  if (options.ops?.length) await applyHomeBatch(location, { baseRevision: 0, ops: options.ops });
  const proxy = new ModelProxy({ home: location });
  await proxy.start(0);
  const pairing = new LocalPairing(RUNNER_INSTANCE);
  const permissions = new SqlitePermissionStore(join(root, "permissions.sqlite"));
  const configs = { current: [] as RunnerProviderConfig[] };
  const inner: ProviderConfigStore = {
    load: () => configs.current.map((config) => ({ ...config })),
    save: (next) => { validateProviderConfigs(next); configs.current = next.map((config) => ({ ...config })); },
    close: () => undefined,
  };
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
  const server = new ControlServer({
    supervisor,
    token: CONTROL_TOKEN,
    bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/aiboard/e2e" }),
    runnerInfo: { projectPath: root, nodeVersion: process.versions.node },
    providerConfigs: new HomeBackedProviderConfigStore(inner, () => readAiboardHomeSync(location)),
    localPairing: pairing,
    home: location,
    modelProxy: proxy,
    permissions,
    ...(options.toolBench ? { toolBench: options.toolBench } : {}),
  });
  const address = await server.start(0);
  const ticket = createLocalPairTicket(RUNNER_INSTANCE);
  pairing.register(ticket.digest);
  const sessionToken = pairing.consume(ticket.code)!;
  return {
    root,
    location,
    url: address.url,
    port: address.port,
    sessionToken,
    permissions,
    async close() {
      await server.close();
      permissions.close();
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Every tab of `context` gets the launcher's sessions in its own sessionStorage, as the pairing
 * link would leave them: the Runner, and optionally the account peer (ChatGPT, Copilot).
 */
export async function pairContext(
  context: BrowserContext,
  runner: Pick<RunnerHome, "port" | "sessionToken">,
  accounts?: { port: number; sessionToken: string },
): Promise<void> {
  const runnerSession = { port: runner.port, instanceId: RUNNER_INSTANCE, kind: "runner", sessionToken: runner.sessionToken };
  const sessions: Record<string, unknown> = { runner: runnerSession };
  if (accounts) sessions.accounts = { port: accounts.port, instanceId: `${RUNNER_INSTANCE}-accounts`, kind: "accounts", sessionToken: accounts.sessionToken };
  await context.addInitScript((stored) => {
    sessionStorage.setItem("aiboard:local-runner-session:v1", JSON.stringify(stored.runner));
    sessionStorage.setItem("aiboard:local-runner-sessions:v1", JSON.stringify(stored.sessions));
  }, { runner: runnerSession, sessions });
}

export interface StubRequest { method: string; url: string; headers: IncomingMessage["headers"]; body: string }

/** A loopback HTTP server standing in for a provider: it records every request and answers with `handle`. */
export async function startStubServer(
  handle: (request: StubRequest, response: ServerResponse) => void | Promise<void>,
): Promise<{ base: string; requests: StubRequest[]; close(): Promise<void> }> {
  const requests: StubRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const record = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body };
    requests.push(record);
    await handle(record, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
