import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { createGitTools } from "../src/git-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

test("task-safe Git tools inspect and commit only the worker branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-git-tools-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "app.txt"), "baseline\n");
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_git",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_git",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_git");
    writeFileSync(join(workspace.path, "app.txt"), "changed\n");
    const broker = brokerWithGit(workspace.path);

    const status = await invoke(broker, "status", "git.status", {});
    assert.deepEqual((json(status) as { entries: unknown[] }).entries, [
      { index: " ", worktree: "M", path: "app.txt" },
    ]);
    const diff = await invoke(broker, "diff", "git.diff", {});
    assert.match(text(diff), /-baseline[\s\S]*\+changed/);

    const commit = await invoke(broker, "commit", "git.commit", {
      message: "Implement task change",
    });
    assert.equal(commit.isError, false);
    assert.match((json(commit) as { revision: string }).revision, /^[a-f0-9]{40,64}$/);
    assert.equal(readFileSync(join(project, "app.txt"), "utf8"), "baseline\n");
    const log = await invoke(broker, "log", "git.log", { limit: 2 });
    assert.equal((json(log) as { commits: Array<{ subject: string }> }).commits[0].subject, "Implement task change");
    const show = await invoke(broker, "show", "git.show", { revision: "HEAD" });
    assert.match(text(show), /changed/);

    const canonicalBroker = brokerWithGit(project);
    writeFileSync(join(project, "app.txt"), "unsafe\n");
    const protectedCommit = await invoke(
      canonicalBroker,
      "protected",
      "git.commit",
      { message: "Must not commit main" }
    );
    assert.equal(protectedCommit.error?.code, "protected_ref");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function brokerWithGit(workspace: string): ToolBroker {
  const broker = new ToolBroker({
    permissionProfile: "project",
    workspacePath: workspace,
  });
  for (const tool of createGitTools()) broker.register(tool);
  return broker;
}

async function invoke(
  broker: ToolBroker,
  callId: string,
  name: string,
  args: unknown
): Promise<ToolResult> {
  return await broker.invoke(
    { type: "tool_call", callId, name, arguments: args },
    {
      runId: "run_git",
      sessionId: "session_git",
      actor: { role: "worker", id: "worker_git" },
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
