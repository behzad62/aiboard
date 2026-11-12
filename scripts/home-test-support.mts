/*
 * A stub Runner whose `/v2/home` is the Runner's real home store (applyHomeBatch,
 * readAiboardHome) in a temp folder: GET answers as control-server.ts homeView,
 * POST as its batch route. Stub keys only; nothing leaves this process.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAiboardHome, AiboardHomeError } from "../runner-v2/src/aiboard-home-paths";
import type { AiboardHomeLocation } from "../runner-v2/src/aiboard-home-paths";
import { applyHomeBatch, readAiboardHome } from "../runner-v2/src/aiboard-home-store";
import { __resetHomeClientForTests, loadHome, type HomeOp } from "../lib/client/home-client";
import { installStubRunner, json, type StubRequest, type StubRunnerOptions } from "./model-proxy-test-support.mts";

export const scratch = mkdtempSync(join(tmpdir(), "aiboard-settings-home-"));
let homeIndex = 0;
export function makeHome(): AiboardHomeLocation {
  homeIndex += 1;
  const root = join(scratch, `home-${homeIndex}`);
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  return resolveAiboardHome({
    platform: process.platform,
    environment: { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") },
    home: userHome,
  });
}

export interface HomeRunner {
  /** The provider upstream behind the model proxy; a test may replace it. */
  upstream?: StubRunnerOptions["upstream"];
  /** Requests that reached the upstream (the model proxy), not the home. */
  requests: StubRequest[];
  location: AiboardHomeLocation;
  /** Every POST /v2/home body this page sent. */
  posts: Array<{ baseRevision: number; ops: HomeOp[] }>;
  rawPosts: string[];
  gets: number;
  failNextPost?: { status: number; code: string; error: string };
  /** The next N POSTs answer 409 home_conflict. */
  conflictPosts: number;
  holdGet?: Promise<void>;
  restore(): void;
}

/** A stub Runner whose `/v2/home` is the real home store; GET as control-server.ts homeView, POST as its batch route. */
export function installHomeRunner(options: { capabilities?: Record<string, boolean>; upstream?: StubRunnerOptions["upstream"]; proxyTokens?: string[]; location?: AiboardHomeLocation } = {}): HomeRunner {
  const runner: HomeRunner = {
    location: options.location ?? makeHome(),
    posts: [],
    rawPosts: [],
    gets: 0,
    conflictPosts: 0,
    upstream: options.upstream,
    requests: [],
    restore: () => undefined,
  };
  const stub = installStubRunner({
    capabilities: options.capabilities,
    proxyTokens: options.proxyTokens,
    upstream: (request) => runner.upstream ? runner.upstream(request) : json({ error: "no upstream stub" }, 500),
    control: async (path, method, body) => {
      if (path !== "/v2/home") return undefined;
      if (method === "GET") {
        runner.gets += 1;
        if (runner.holdGet) await runner.holdGet;
        const snapshot = await readAiboardHome(runner.location);
        const keys = (entries: Record<string, { keyHint: string }> | undefined) =>
          Object.fromEntries(Object.entries(entries ?? {}).map(([id, entry]) => [id, { hasKey: true, keyHint: entry.keyHint }]));
        return json({
          home: runner.location.home,
          keyPath: runner.location.keyPath,
          revision: snapshot.revision,
          pathRevisions: snapshot.config.pathRevisions,
          config: snapshot.config,
          credentials: snapshot.credentials ? {
            providers: keys(snapshot.credentials.providers),
            customModels: keys(snapshot.credentials.customModels),
            ...(snapshot.credentials.remoteMcpAuthorizationToken ? { remoteMcpAuthorizationToken: { hasKey: true, keyHint: snapshot.credentials.remoteMcpAuthorizationToken.keyHint } } : {}),
          } : null,
        });
      }
      if (method === "POST") {
        runner.rawPosts.push(body);
        const batch = JSON.parse(body) as { baseRevision: number; ops: HomeOp[] };
        runner.posts.push(batch);
        if (runner.conflictPosts > 0) {
          runner.conflictPosts -= 1;
          const current = await readAiboardHome(runner.location, { credentials: false });
          return json({ code: "home_conflict", error: "A section of this batch changed after its base revision.", currentRevision: current.revision, sections: {} }, 409);
        }
        if (runner.failNextPost) {
          const failure = runner.failNextPost;
          runner.failNextPost = undefined;
          return json({ code: failure.code, error: failure.error }, failure.status);
        }
        // As the Runner's batch route: ChatGPT and Copilot never take a key in the home (OD-32).
        if (batch.ops.some((op) => /^credentials\.providers\.(chatgpt|github-copilot)$/.test(op.path))) {
          return json({ code: "home_invalid_op", error: "This provider takes no key." }, 422);
        }
        try {
          const result = await applyHomeBatch(runner.location, batch);
          return json({ revision: result.revision, touched: result.touched, removedCredentials: result.removedCredentials });
        } catch (error) {
          if (error instanceof AiboardHomeError) {
            return json({ code: error.code, error: error.message }, error.code === "home_conflict" ? 409 : 400);
          }
          throw error;
        }
      }
      return undefined;
    },
  });
  runner.requests = stub.requests;
  runner.restore = () => stub.restore();
  return runner;
}

/** A page connected to a fresh stub home: the first GET has completed. */
export async function connectStubHome(options: Parameters<typeof installHomeRunner>[0] & { seed?: HomeOp[] } = {}): Promise<HomeRunner> {
  __resetHomeClientForTests();
  const runner = installHomeRunner(options);
  if (options.seed?.length) await applyHomeBatch(runner.location, { baseRevision: 0, ops: options.seed });
  const state = await loadHome();
  assert.equal(state.status, "ready", "the stub home is connected");
  return runner;
}

export function removeStubHomes(): void {
  rmSync(scratch, { recursive: true, force: true });
}

export type { StubRequest };
