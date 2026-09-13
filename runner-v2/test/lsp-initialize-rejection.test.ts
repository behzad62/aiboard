import { openSqliteStreamingSessionStore } from "../src/streaming-session-store.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedLspTest as test, disposeLspTestRoot } from "./support/lsp-test-scope.js";
import { createOwnedLspFixture } from "./support/lsp-owned-fixture.js";
import { LspClientError } from "../src/lsp-client.js";

test("LSP real invalid initialization keeps its protocol code and verifies every pre-adoption resource", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-invalid-init-"));
  t.diagnostic(`exact failed-initialize fixture acquired: ${root}`);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const owned = createOwnedLspFixture(root, workspace); const run = await owned.ensure();
  const client = owned.client({ command: process.execPath, workspaceRoot: workspace,
    args: [fileURLToPath(new URL("./fixtures/lsp-server.mjs", import.meta.url))], requestTimeoutMs: 500,
    restartLimit: 0, env: { LSP_FIXTURE_POSITION_ENCODING: "utf-8" } });
  try {
    await assert.rejects(client.start(), (error: unknown) => error instanceof LspClientError && error.code === "protocol_error");
    assert.deepEqual(run.streamingState.listSessionIds(), [], "rejected initialization must never adopt");
    const kernel = openSqliteStreamingSessionStore(join(run.runRoot, "streaming-sessions.sqlite"), await readFile(join(run.runRoot, "streaming-sessions.key")), { readOnly: true });
    try {
      const launches = kernel.store.listHostLaunchIds(); assert.equal(launches.length, 1);
      for (const id of launches) assert.equal(kernel.store.readHostLaunch(id)!.state, "released", "a typed initialization rejection does not excuse retained resource ownership");
    } finally { kernel.store.close(); }
    await owned.close();
  } finally { await disposeLspTestRoot(root); }
});
