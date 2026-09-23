import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { ArchitectActionRequest } from "../src/build-runtime.js";
import { BuildRuntime } from "../src/build-runtime.js";
import type { ChangeSet } from "../src/change-set.js";
import {
  buildCompletionReadiness,
  rebuildSchedulerProjection,
  type SchedulerActor,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import {
  CLAUDE_POINTER_LINE,
  DEFAULT_AGENTS_SECTION_BODY,
  DEFAULT_README_TEMPLATE,
  DEFAULT_STATE_TEMPLATE,
  AGENTS_SECTION_END,
  AGENTS_SECTION_START,
  spliceMarkedArchitectSection,
} from "../src/project-docs.js";
import {
  IntegrationManager,
  WorkspaceManager,
  captureGitBaseline,
  createChangeSet,
  runGit,
} from "./support/git-fixture.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

const HASH = "a".repeat(64);
const WHEN = "2026-09-23T00:00:00.000Z";

test("a new empty store is stamped before run.initialized", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-stamp-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const runtime = new BuildRuntime({
      runId: "run_stamp",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    const types = runtime.events().map((event) => event.type);
    assert.equal(types[0], "project_docs.policy_configured");
    assert.equal(runtime.events()[0]?.payload.version, 1);
    assert.equal(types[1], "run.initialized");
    assert.equal(runtime.projection().projectDocsPolicyVersion, 1);
    const again = new BuildRuntime({
      runId: "run_stamp",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    assert.equal(
      again.events().filter((event) => event.type === "project_docs.policy_configured").length,
      1,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash after the stamp still initializes once and does not stamp again", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-stamp-crash-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(event("run_stamp_crash", "project_docs.policy_configured", runner(), "project-docs-policy", { version: 1 }));
    const runtime = new BuildRuntime({
      runId: "run_stamp_crash",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    const types = runtime.events().map((eventItem) => eventItem.type);
    assert.deepEqual(
      types.filter((type) => type === "project_docs.policy_configured" || type === "run.initialized"),
      ["project_docs.policy_configured", "run.initialized"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-seeded run is never stamped", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-legacy-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(event("run_legacy", "run.initialized", runner(), "run-initialized", {}));
    const runtime = new BuildRuntime({
      runId: "run_legacy",
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    assert.equal(
      runtime.events().some((item) => item.type === "project_docs.policy_configured"),
      false,
    );
    assert.equal(runtime.projection().projectDocsPolicyVersion, undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan-only completion names the missing project documents", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-ready-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    seedPlanOnly(store, "run_docs_ready");
    const missing = buildCompletionReadiness(rebuildSchedulerProjection(store.readRun("run_docs_ready")));
    assert.equal(missing.ready, false);
    assert.ok(missing.issues.includes("docs/project/STATE.md has not been committed."));
    assert.throws(
      () => store.append(event(
        "run_docs_ready",
        "project.handoff_requested",
        architect(),
        "handoff-missing",
        { summary: "Ready." },
      )),
      /docs\/project\/STATE.md has not been committed\./,
    );
    commitDoc(store, "run_docs_ready", "docs/project/STATE.md", "req-state", {
      readme: false,
      agentsMarkedSection: false,
      claudePointer: false,
      parent: "baseline",
      commit: "doc-state",
    });
    const facts = buildCompletionReadiness(rebuildSchedulerProjection(store.readRun("run_docs_ready")));
    assert.ok(facts.issues.includes("Project documentation entry point is missing docs/project/README.md."));
    assert.ok(facts.issues.includes("Project documentation entry point is missing the marked AGENTS.md section."));
    assert.ok(facts.issues.includes("Project documentation entry point is missing the marked CLAUDE.md pointer."));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("STATE.md must be newer than the latest canonical integration", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-currency-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    seedStamped(store, "run_docs_currency");
    store.append(event("run_docs_currency", "plan.created", architect(), "plan", {
      revision: 1,
      tasks: [integratingTask("task_keep"), integratingTask("task_clear")],
    }));
    store.append(event("run_docs_currency", "task.transitioned", runner(), "integrate-keep", {
      taskId: "task_keep",
      status: "integrated",
      patch: { integrationRevision: "revision_keep" },
    }));
    const integrated = rebuildSchedulerProjection(store.readRun("run_docs_currency"));
    commitDoc(store, "run_docs_currency", "docs/project/STATE.md", "req-after", {
      readme: true,
      agentsMarkedSection: true,
      claudePointer: true,
      parent: "revision_keep",
      commit: "doc_tip",
    });
    const current = buildCompletionReadiness(rebuildSchedulerProjection(store.readRun("run_docs_currency")));
    assert.equal(
      current.issues.some((issue) => issue.includes("STATE.md")),
      false,
      current.issues.join(" | "),
    );
    assert.equal(
      rebuildSchedulerProjection(store.readRun("run_docs_currency")).projectDocs?.documentTip,
      "doc_tip",
    );
    assert.equal(integrated.latestIntegratedTaskSequence !== undefined, true);
    store.append(event("run_docs_currency", "task.transitioned", runner(), "integrate-equal", {
      taskId: "task_clear",
      status: "integrated",
      patch: { integrationRevision: "revision_keep" },
    }));
    const kept = rebuildSchedulerProjection(store.readRun("run_docs_currency"));
    assert.equal(kept.projectDocs?.documentTip, "doc_tip");
    assert.equal(kept.integrationRevision, "revision_keep");
    assert.equal(kept.latestIntegratedTaskSequence, integrated.latestIntegratedTaskSequence);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a canonical integration after a document commit clears the document tip", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-tip-clear-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    seedStamped(store, "run_tip_clear");
    store.append(event("run_tip_clear", "plan.created", architect(), "plan", {
      revision: 1,
      tasks: [integratingTask("task_old"), integratingTask("task_new")],
    }));
    commitDoc(store, "run_tip_clear", "docs/project/STATE.md", "req-first", {
      readme: true,
      agentsMarkedSection: true,
      claudePointer: true,
      parent: "none",
      commit: "doc_first",
    });
    store.append(event("run_tip_clear", "task.transitioned", runner(), "integrate-old", {
      taskId: "task_old",
      status: "integrated",
      patch: { integrationRevision: "revision_old" },
    }));
    const advanced = rebuildSchedulerProjection(store.readRun("run_tip_clear"));
    assert.equal(advanced.projectDocs?.documentTip, undefined);
    assert.equal(advanced.integrationRevision, "revision_old");
    const stale = buildCompletionReadiness(advanced);
    assert.ok(stale.issues.includes("docs/project/STATE.md is older than the latest integrated change."));
    commitDoc(store, "run_tip_clear", "docs/project/STATE.md", "req-second", {
      readme: true,
      agentsMarkedSection: true,
      claudePointer: true,
      parent: "revision_old",
      commit: "doc_second",
    });
    store.append(event("run_tip_clear", "task.transitioned", runner(), "integrate-new", {
      taskId: "task_new",
      status: "integrated",
      patch: { integrationRevision: "revision_new" },
    }));
    const cleared = rebuildSchedulerProjection(store.readRun("run_tip_clear"));
    assert.equal(cleared.integrationRevision, "revision_new");
    assert.equal(cleared.projectDocs?.documentTip, undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("document commits record the architect author once and leave the project tree unchanged", async () => {
  const fixture = await openGitFixture("author");
  try {
    const before = hashTree(fixture.project);
    const first = await fixture.integration.commitProjectDocuments({
      writes: entryPointWrites(),
      summary: "Record the project entry point",
      runId: fixture.runId,
      requestId: "project-doc:1:docs/project/STATE.md",
    });
    const second = await fixture.integration.commitProjectDocuments({
      writes: entryPointWrites(),
      summary: "Record the project entry point",
      runId: fixture.runId,
      requestId: "project-doc:1:docs/project/STATE.md",
    });
    assert.equal(second.commit, first.commit);
    assert.equal(hashTree(fixture.project), before);
    const body = await gitText(fixture.integration.path, ["log", "-1", "--format=%an%n%ae%n%cn%n%ce%n%B"]);
    const lines = body.split(/\r?\n/);
    assert.equal(lines[0], "AIBoard Architect");
    assert.equal(lines[1], "architect@aiboard.local");
    assert.equal(lines[2], "AIBoard Architect");
    assert.equal(lines[3], "architect@aiboard.local");
    assert.equal(lines.includes(`AIBoard-Run: ${fixture.runId}`), true);
    assert.equal(lines.includes("AIBoard-Author: architect"), true);
    assert.equal(lines.includes("AIBoard-Doc-Request: project-doc:1:docs/project/STATE.md"), true);
    assert.equal(await requestCount(fixture.integration.path, fixture.baseline.revision, "project-doc:1:docs/project/STATE.md"), 1);
    assert.equal(first.entryPoint.readme, true);
    assert.equal(first.entryPoint.agentsMarkedSection, true);
    assert.equal(first.entryPoint.claudePointer, true);
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), false);
    await fixture.integration.applyToProject();
    assert.equal(readFileSync(join(fixture.project, "docs", "project", "STATE.md"), "utf8").includes("## Next action"), true);
    assert.equal(existsSync(join(fixture.project, "docs", "project", "README.md")), true);
    assert.equal(existsSync(join(fixture.project, "AGENTS.md")), true);
    assert.equal(existsSync(join(fixture.project, "CLAUDE.md")), true);
  } finally {
    fixture.close();
  }
});

test("marked AGENTS.md bytes outside the section stay identical", async () => {
  const fixture = await openGitFixture("splice");
  try {
    const surrounding = `alpha\n${AGENTS_SECTION_START}\nold body\n${AGENTS_SECTION_END}\nomega`;
    writeFileSync(join(fixture.integration.path, "AGENTS.md"), surrounding);
    await runGit({ cwd: fixture.integration.path, args: ["add", "--", "AGENTS.md"] });
    await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "Existing agent notes"] });
    await fixture.integration.commitProjectDocuments({
      writes: [{ path: "AGENTS.md", content: DEFAULT_AGENTS_SECTION_BODY }],
      summary: "Replace the marked agent section",
      runId: fixture.runId,
      requestId: "project-doc:2:AGENTS.md",
    });
    assert.equal(
      readFileSync(join(fixture.integration.path, "AGENTS.md"), "utf8"),
      spliceMarkedArchitectSection(surrounding, DEFAULT_AGENTS_SECTION_BODY),
    );
  } finally {
    fixture.close();
  }
});

test("a symbolic link under docs/project is refused", async () => {
  const fixture = await openGitFixture("link");
  try {
    const outside = join(fixture.root, "outside-docs");
    mkdirSync(outside);
    mkdirSync(join(fixture.integration.path, "docs"));
    symlinkSync(outside, join(fixture.integration.path, "docs", "project"), "junction");
    const before = await gitText(fixture.integration.path, ["rev-parse", "HEAD"]);
    await assert.rejects(
      () => fixture.integration.commitProjectDocuments({
        writes: [{ path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE }],
        summary: "Write state through a link",
        runId: fixture.runId,
        requestId: "project-doc:3:docs/project/STATE.md",
      }),
      /symbolic link or junction/,
    );
    assert.equal(await gitText(fixture.integration.path, ["rev-parse", "HEAD"]), before);
    assert.equal(existsSync(join(outside, "STATE.md")), false);
  } finally {
    fixture.close();
  }
});

test("a worker change under docs/project conflicts before cherry-pick", async () => {
  const fixture = await openGitFixture("conflict");
  try {
    const workspace = await fixture.workspaces.createTaskWorkspace("docs_writer");
    mkdirSync(join(workspace.path, "docs", "project"), { recursive: true });
    writeFileSync(join(workspace.path, "docs", "project", "NOTES.md"), "worker note\n");
    const taskCommit = await fixture.workspaces.commitTask("docs_writer", "Write a project note");
    const changeSet = await createChangeSet({
      workspacePath: workspace.path,
      taskCommit,
      artifacts: fixture.artifacts,
      evidenceArtifactHashes: [fixture.evidence.hash],
    });
    const before = fixture.integration.revision;
    const result = await fixture.integration.integrate(changeSet);
    assert.equal(result.status, "conflict");
    if (result.status === "conflict") {
      assert.ok(result.conflictPaths.some((path) => path.replace(/\\/g, "/").startsWith("docs/project/")));
    }
    assert.equal(fixture.integration.revision, before);
    assert.equal(existsSync(join(fixture.integration.path, "docs", "project", "NOTES.md")), false);
  } finally {
    fixture.close();
  }
});

test("document tip stays for an empty change set and an older applied revision", async () => {
  const fixture = await openGitFixture("tip");
  try {
    const first = await integrateFile(fixture, "feature_a", "src/a.txt", "a\n");
    assert.equal(first.status, "integrated");
    const documents = await fixture.integration.commitProjectDocuments({
      writes: entryPointWrites(),
      summary: "Record documents between integrations",
      runId: fixture.runId,
      requestId: "project-doc:4:docs/project/STATE.md",
    });
    const tip = documents.commit;
    assert.equal(fixture.integration.revision, tip);
    const replay = await fixture.integration.integrate(first.changeSet);
    assert.equal(replay.status, "integrated");
    assert.equal(replay.integrationRevision, first.integrationRevision);
    assert.equal(await fixture.integration.relateToDocumentTip({
      revision: replay.integrationRevision,
      tip,
    }), "ancestor");
    const empty = await fixture.integration.integrate(emptyChangeSet(fixture, "empty_keep"));
    assert.equal(empty.status, "integrated");
    assert.equal(empty.integrationRevision, tip);
    assert.equal(await fixture.integration.relateToDocumentTip({
      revision: empty.integrationRevision,
      tip,
    }), "equal_to_tip");
    const second = await integrateFile(fixture, "feature_b", "src/b.txt", "b\n");
    assert.equal(second.status, "integrated");
    assert.equal(await fixture.integration.relateToDocumentTip({
      revision: second.integrationRevision,
      tip,
    }), "strict_descendant");
    assert.notEqual(second.integrationRevision, tip);
  } finally {
    fixture.close();
  }
});

test("restart recovery commits a pending document request once", async () => {
  const fixture = await openGitFixture("restart");
  const store = new SqliteSchedulerStore(join(fixture.state, "scheduler.sqlite"));
  try {
    const runtime = new BuildRuntime({
      runId: fixture.runId,
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      artifacts: fixture.artifacts,
      projectDocs: {
        commit: (input) => fixture.integration.commitProjectDocuments(input),
        relateRevision: (input) => fixture.integration.relateToDocumentTip(input),
      },
    });
    assert.equal(runtime.events()[0]?.type, "project_docs.policy_configured");
    const content = DEFAULT_STATE_TEMPLATE;
    const artifact = await fixture.artifacts.put(Buffer.from(content, "utf8"), "text/markdown", "docs/project/STATE.md");
    const requested = store.append(event(fixture.runId, "project_doc.requested", architect(), "project-doc:pending:docs/project/STATE.md", {
      requestId: "project-doc:pending:docs/project/STATE.md",
      path: "docs/project/STATE.md",
      contentArtifactHash: artifact.hash,
      contentBytes: Buffer.byteLength(content, "utf8"),
      summary: "Write the project state",
    }));
    assert.equal(requested.type, "project_doc.requested");
    await fixture.integration.commitProjectDocuments({
      writes: [{ path: "docs/project/STATE.md", content }],
      summary: "Write the project state",
      runId: fixture.runId,
      requestId: "project-doc:pending:docs/project/STATE.md",
    });
    assert.equal(
      store.readRun(fixture.runId).some((item) => item.type === "project_doc.committed"),
      false,
    );
    let architectEntered = false;
    const completeCalls = 0;
    const recovered = new BuildRuntime({
      runId: fixture.runId,
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          architectEntered = true;
          assert.equal(
            store.readRun(fixture.runId).some((item) => item.type === "project_doc.committed"),
            true,
          );
          assert.equal(request.reason.type, "plan_required");
          await invoke(request, "plan_tasks", {
            revision: 1,
            tasks: [{
              id: "task_plan",
              objective: "Describe the work",
              dependencies: [],
              requiredCapabilities: ["code"],
              acceptanceCriteria: [{ id: "planned", text: "The plan exists." }],
            }],
          });
        },
      },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      artifacts: fixture.artifacts,
      projectDocs: {
        commit: (input) => fixture.integration.commitProjectDocuments(input),
        relateRevision: (input) => fixture.integration.relateToDocumentTip(input),
      },
    });
    await recovered.step();
    assert.equal(architectEntered, true);
    assert.equal(completeCalls, 0);
    assert.equal(
      recovered.events().filter((item) => item.type === "project_doc.committed").length,
      1,
    );
    const recoveredCommits = await requestCount(
      fixture.integration.path,
      fixture.baseline.revision,
      "project-doc:pending:docs/project/STATE.md",
    );
    assert.equal(
      recoveredCommits,
      1,
      `request-id lookup must leave one commit, found ${recoveredCommits}`,
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("same-turn project document commit is durable before complete_run returns", async () => {
  const fixture = await openGitFixture("same-turn");
  const store = new SqliteSchedulerStore(join(fixture.state, "scheduler.sqlite"));
  try {
    let sawCommittedBeforeComplete = false;
    const runtime = new BuildRuntime({
      runId: fixture.runId,
      store,
      runPolicy: "plan_only",
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          if (request.reason.type === "plan_required") {
            await invoke(request, "plan_tasks", {
              revision: 1,
              tasks: [{
                id: "task_plan",
                objective: "Describe the work",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "planned", text: "The plan exists." }],
              }],
            });
            return;
          }
          assert.equal(request.reason.type, "completion_decision_required");
          const before = new Set(store.readRun(fixture.runId).map((item) => item.eventId));
          for (const write of entryPointWrites()) {
            await invoke(request, "write_project_doc", {
              path: write.path,
              content: write.content,
              summary: `Write ${write.path}`,
            });
          }
          const added = store.readRun(fixture.runId).filter((item) => !before.has(item.eventId));
          assert.ok(added.length > 0);
          assert.ok(added.every((item) =>
            item.type === "project_doc.requested" || item.type === "project_doc.committed"
          ));
          sawCommittedBeforeComplete = added.some((item) =>
            item.type === "project_doc.committed" && item.payload.path === "docs/project/STATE.md"
          );
          await invoke(request, "complete_run", { summary: "The plan is ready." });
        },
      },
      integrationDriver: {
        integrate: async () => {
          throw new Error("plan_only must not integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      artifacts: fixture.artifacts,
      projectDocs: {
        commit: (input) => fixture.integration.commitProjectDocuments(input),
        relateRevision: (input) => fixture.integration.relateToDocumentTip(input),
      },
    });
    assert.equal((await runtime.step()).action, "plan_required");
    const completed = await runtime.step();
    assert.equal(completed.status, "paused");
    assert.equal(sawCommittedBeforeComplete, true);
    assert.equal(runtime.projection().projectHandoff?.status, "requested");
    const committed = [...runtime.events()].reverse().find((item) => item.type === "project_doc.committed");
    const requested = runtime.events().find((item) => item.type === "project.handoff_requested");
    assert.ok(committed && requested && committed.sequence < requested.sequence);
  } finally {
    store.close();
    fixture.close();
  }
});

test("plan_only completion without documents names STATE.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-doc-plan-only-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    let refusal = "";
    const runtime = new BuildRuntime({
      runId: "run_plan_only_docs",
      store,
      runPolicy: "plan_only",
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          if (request.reason.type === "plan_required") {
            await invoke(request, "plan_tasks", {
              revision: 1,
              tasks: [{
                id: "task_plan",
                objective: "Describe the work",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "planned", text: "The plan exists." }],
              }],
            });
            return;
          }
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "complete_without_docs",
            name: "complete_run",
            arguments: { summary: "The plan is ready." },
          }, request.context);
          refusal = result.error?.message ?? "";
        },
      },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      artifacts: new ArtifactStore(join(root, "artifacts")),
      projectDocs: {
        commit: async () => {
          throw new Error("complete_run must not commit when the tool refuses");
        },
        relateRevision: async () => "strict_descendant",
      },
    });
    await runtime.step();
    await assert.rejects(() => runtime.step(), /without a typed action/);
    assert.match(refusal, /docs\/project\/STATE.md has not been committed\./);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical STATE.md content in a second request commits after integration and allows completion", async () => {
  const fixture = await openGitFixture("unchanged");
  const evidenceStore = new SqliteEvidenceStore(join(fixture.state, "evidence.sqlite"));
  const evidence = evidenceStore.record({
    runId: fixture.runId,
    taskId: "task_same",
    actor: { role: "worker", id: "worker_task_same_1" },
    fact: {
      kind: "browser_screenshot",
      label: "task_same evidence",
      capturedAt: WHEN,
      screenshotArtifactHash: "e".repeat(64),
      mediaType: "image/png",
      byteLength: 10,
    },
    createdAt: WHEN,
    idempotencyKey: "evidence:task_same",
    attempt: 1,
  });
  const changeSet = await changeSetForFile(fixture, "task_same", "src/feature.txt", "feature\n");
  const store = new SqliteSchedulerStore(join(fixture.state, "scheduler.sqlite"), {
    evidenceStore,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  const actions: string[] = [];
  try {
    const runtime = new BuildRuntime({
      runId: fixture.runId,
      store,
      evidenceStore,
      workerDriver: {
        run: async (assignment) => ({
          type: "submitted",
          changeSetId: changeSet.id,
          criterionEvidenceLinks: [{
            criterionId: "done",
            evidenceId: evidence.id,
            artifactHashes: ["e".repeat(64)],
            taskId: assignment.task.id,
            attempt: assignment.attempt,
          }],
        }),
      },
      architectDriver: {
        run: async (request) => {
          if (request.reason.type === "plan_required") {
            for (const write of entryPointWrites()) {
              await invoke(request, "write_project_doc", {
                path: write.path,
                content: write.content,
                summary: `Write ${write.path}`,
              });
            }
            await invoke(request, "plan_tasks", {
              revision: 1,
              tasks: [{
                id: "task_same",
                objective: "Implement the feature",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "done", text: "The feature exists." }],
              }],
            });
            return;
          }
          if (request.reason.type === "review_required") {
            const task = request.projection.tasks[request.reason.taskId];
            const links = task.criterionEvidenceLinks ?? [];
            await invoke(request, "review_task", {
              taskId: request.reason.taskId,
              decision: "approved",
              summary: "The feature matches the request.",
              evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
              criterionVerdicts: (task.acceptanceCriteria ?? []).map((criterion) => {
                const link = links.find((candidate) => candidate.criterionId === criterion.id);
                return {
                  criterionId: criterion.id,
                  verdict: "satisfied",
                  rationale: "The worker evidence supports this criterion.",
                  evidenceIds: link ? [link.evidenceId] : [],
                  artifactHashes: link?.artifactHashes,
                };
              }),
            });
            return;
          }
          if (request.reason.type === "integration_approval_required") {
            await invoke(request, "request_integration", { taskId: request.reason.taskId });
            return;
          }
          if (request.reason.type === "final_verification_plan_required") {
            await invoke(request, "plan_final_verification", {
              plan: {
                checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
                  category,
                  status: "not_applicable",
                  rationale: `No ${category} fixture is configured.`,
                  repositoryInspection: {
                    paths: ["package.json"],
                    summary: `No ${category} fixture is configured.`,
                  },
                })),
              },
            });
            return;
          }
          if (request.reason.type === "final_verification_review_required") {
            const current = request.projection.finalVerification?.current;
            if (!current?.plan || !current.submission) {
              throw new Error("Final verification review is missing its submission.");
            }
            await invoke(request, "review_final_verification", {
              taskId: request.reason.taskId,
              generationId: request.reason.generationId,
              targetRevision: request.reason.targetRevision,
              submissionId: request.reason.submissionId,
              attempt: current.submission.attempt,
              decision: "approved",
              summary: "Every persisted final-verification category supports approval.",
              architectRisk: "low",
              architectRiskRationale: "No additional semantic risk beyond the kernel-observed paths.",
              categoryReviews: current.plan.checks.map((check) => ({
                category: check.category,
                verdict: "approved",
                rationale: `The persisted ${check.category} result supports this semantic decision.`,
                evidenceIds: [],
              })),
            });
            return;
          }
          if (request.reason.type === "completion_decision_required") {
            const stale = buildCompletionReadiness(runtime.projection());
            assert.ok(stale.issues.includes("docs/project/STATE.md is older than the latest integrated change."));
            await invoke(request, "write_project_doc", {
              path: "docs/project/STATE.md",
              content: DEFAULT_STATE_TEMPLATE,
              summary: "Rewrite the project state",
            });
            const ready = buildCompletionReadiness(runtime.projection());
            assert.equal(ready.ready, true, ready.issues.join(" | "));
            await invoke(request, "complete_run", { summary: "The feature and its documents are ready." });
            return;
          }
          throw new Error(`Unexpected Architect reason ${request.reason.type}`);
        },
      },
      integrationDriver: {
        integrate: async () => {
          const result = await fixture.integration.integrate(changeSet);
          if (result.status !== "integrated") {
            return {
              status: "conflict" as const,
              integrationRevision: result.integrationRevision,
              conflictPaths: result.status === "conflict" ? result.conflictPaths : [],
            };
          }
          return { status: "integrated" as const, integrationRevision: result.integrationRevision };
        },
      },
      finalVerificationDriver: {
        executeCheck: async ({ category, plan }) => ({
          workspacePath: fixture.project,
          startedAt: WHEN,
          finishedAt: WHEN,
          check: {
            ...plan.checks.find((check) => check.category === category)!,
            green: true,
            evidenceIds: [],
            facts: [],
            issues: [],
          },
        }),
      },
      finalVerificationCleanupDriver: { cleanup: async () => ({}) },
      finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
      maxConcurrency: 1,
      maxTaskAttempts: 2,
      workspaceFor: async () => fixture.project,
      artifacts: fixture.artifacts,
      projectDocs: {
        commit: (input) => fixture.integration.commitProjectDocuments(input),
        relateRevision: (input) => fixture.integration.relateToDocumentTip(input),
      },
    });
    for (let index = 0; index < 24; index += 1) {
      const step = await runtime.step();
      actions.push(`${step.status}:${step.action ?? ""}`);
      if (runtime.projection().projectHandoff?.status === "requested") break;
      if (step.status === "paused" || step.status === "failed" || step.status === "idle") break;
    }
    assert.equal(runtime.projection().projectHandoff?.status, "requested", actions.join(","));
    const stateCommits = runtime.events().filter((item) =>
      item.type === "project_doc.committed" && item.payload.path === "docs/project/STATE.md"
    );
    assert.equal(stateCommits.length, 2);
    const integrated = runtime.events().find((item) =>
      item.type === "task.transitioned" && item.payload.status === "integrated"
    );
    assert.ok(integrated);
    assert.ok(stateCommits[0]!.sequence < integrated.sequence);
    assert.ok(stateCommits[1]!.sequence > integrated.sequence);
    assert.notEqual(stateCommits[0]!.payload.commit, stateCommits[1]!.payload.commit);
    for (const item of stateCommits) {
      const requestId = item.payload.requestId;
      const commit = item.payload.commit;
      assert.equal(typeof requestId, "string");
      assert.equal(typeof commit, "string");
      const body = await gitText(fixture.integration.path, ["log", "-1", "--format=%B", String(commit)]);
      const lines = body.split(/\r?\n/).map((line) => line.trim());
      assert.equal(lines.includes(`AIBoard-Run: ${fixture.runId}`), true);
      assert.equal(lines.includes("AIBoard-Author: architect"), true);
      assert.equal(lines.includes(`AIBoard-Doc-Request: ${String(requestId)}`), true);
      assert.equal(
        await requestCount(fixture.integration.path, fixture.baseline.revision, String(requestId)),
        1,
      );
    }
  } finally {
    store.close();
    evidenceStore.close();
    fixture.close();
  }
});

test("handoff after STATE.md keeps final verification current", async () => {
  const fixture = await openGitFixture("handoff");
  const evidenceStore = new SqliteEvidenceStore(join(fixture.state, "evidence.sqlite"));
  const evidence = evidenceStore.record({
    runId: fixture.runId,
    taskId: "task_docs",
    actor: { role: "worker", id: "worker_task_docs_1" },
    fact: {
      kind: "browser_screenshot",
      label: "task_docs evidence",
      capturedAt: WHEN,
      screenshotArtifactHash: "e".repeat(64),
      mediaType: "image/png",
      byteLength: 10,
    },
    createdAt: WHEN,
    idempotencyKey: "evidence:task_docs",
    attempt: 1,
  });
  const feature = await integrateFile(fixture, "task_docs", "src/feature.txt", "feature\n");
  const store = new SqliteSchedulerStore(join(fixture.state, "scheduler.sqlite"), {
    evidenceStore,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  const projectBefore = hashTree(fixture.project);
  const actions: string[] = [];
  try {
    const runtime = new BuildRuntime({
      runId: fixture.runId,
      store,
      evidenceStore,
      workerDriver: {
        run: async (assignment) => ({
          type: "submitted",
          changeSetId: "changeset_docs",
          criterionEvidenceLinks: [{
            criterionId: "done",
            evidenceId: evidence.id,
            artifactHashes: ["e".repeat(64)],
            taskId: assignment.task.id,
            attempt: assignment.attempt,
          }],
        }),
      },
      architectDriver: {
        run: async (request) => {
          if (request.reason.type === "plan_required") {
            await invoke(request, "plan_tasks", {
              revision: 1,
              tasks: [{
                id: "task_docs",
                objective: "Implement the feature",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "done", text: "The feature exists." }],
              }],
            });
            return;
          }
          if (request.reason.type === "review_required") {
            const task = request.projection.tasks[request.reason.taskId];
            const links = task.criterionEvidenceLinks ?? [];
            await invoke(request, "review_task", {
              taskId: request.reason.taskId,
              decision: "approved",
              summary: "The feature matches the request.",
              evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
              criterionVerdicts: (task.acceptanceCriteria ?? []).map((criterion) => {
                const link = links.find((candidate) => candidate.criterionId === criterion.id);
                return {
                  criterionId: criterion.id,
                  verdict: "satisfied",
                  rationale: "The worker evidence supports this criterion.",
                  evidenceIds: link ? [link.evidenceId] : [],
                  artifactHashes: link?.artifactHashes,
                };
              }),
            });
            return;
          }
          if (request.reason.type === "integration_approval_required") {
            await invoke(request, "request_integration", { taskId: request.reason.taskId });
            return;
          }
          if (request.reason.type === "final_verification_plan_required") {
            await invoke(request, "plan_final_verification", {
              plan: {
                checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
                  category,
                  status: "not_applicable",
                  rationale: `No ${category} fixture is configured.`,
                  repositoryInspection: {
                    paths: ["package.json"],
                    summary: `No ${category} fixture is configured.`,
                  },
                })),
              },
            });
            return;
          }
          if (request.reason.type === "final_verification_review_required") {
            const current = request.projection.finalVerification?.current;
            if (!current?.plan || !current.submission) {
              throw new Error("Final verification review is missing its submission.");
            }
            await invoke(request, "review_final_verification", {
              taskId: request.reason.taskId,
              generationId: request.reason.generationId,
              targetRevision: request.reason.targetRevision,
              submissionId: request.reason.submissionId,
              attempt: current.submission.attempt,
              decision: "approved",
              summary: "Every persisted final-verification category supports approval.",
              architectRisk: "low",
              architectRiskRationale: "No additional semantic risk beyond the kernel-observed paths.",
              categoryReviews: current.plan.checks.map((check) => ({
                category: check.category,
                verdict: "approved",
                rationale: `The persisted ${check.category} result supports this semantic decision.`,
                evidenceIds: [],
              })),
            });
            return;
          }
          if (request.reason.type === "completion_decision_required") {
            const tasksBefore = Object.keys(request.projection.tasks).length;
            for (const write of entryPointWrites()) {
              await invoke(request, "write_project_doc", {
                path: write.path,
                content: write.content,
                summary: `Write ${write.path}`,
              });
            }
            assert.equal(Object.keys(runtime.projection().tasks).length, tasksBefore);
            await invoke(request, "complete_run", { summary: "The feature and its documents are ready." });
            return;
          }
          throw new Error(`Unexpected Architect reason ${request.reason.type}`);
        },
      },
      integrationDriver: {
        integrate: async () => {
          const result = await fixture.integration.integrate(feature.changeSet);
          if (result.status !== "integrated") {
            return {
              status: "conflict" as const,
              integrationRevision: result.integrationRevision,
              conflictPaths: result.status === "conflict" ? result.conflictPaths : [],
            };
          }
          return { status: "integrated" as const, integrationRevision: result.integrationRevision };
        },
      },
      finalVerificationDriver: {
        executeCheck: async ({ category, plan }) => ({
          workspacePath: fixture.project,
          startedAt: WHEN,
          finishedAt: WHEN,
          check: {
            ...plan.checks.find((check) => check.category === category)!,
            green: true,
            evidenceIds: [],
            facts: [],
            issues: [],
          },
        }),
      },
      finalVerificationCleanupDriver: { cleanup: async () => ({}) },
      finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
      maxConcurrency: 1,
      maxTaskAttempts: 2,
      workspaceFor: async () => fixture.project,
      artifacts: fixture.artifacts,
      projectDocs: {
        commit: (input) => fixture.integration.commitProjectDocuments(input),
        relateRevision: (input) => fixture.integration.relateToDocumentTip(input),
      },
    });
    for (let index = 0; index < 24; index += 1) {
      const step = await runtime.step();
      actions.push(`${step.status}:${step.action ?? ""}`);
      if (runtime.projection().projectHandoff?.status === "requested") break;
      if (step.status === "paused" || step.status === "failed" || step.status === "idle") break;
    }
    assert.equal(runtime.projection().projectHandoff?.status, "requested", actions.join(","));
    assert.equal(hashTree(fixture.project), projectBefore);
    const canonical = runtime.projection().integrationRevision;
    const tip = runtime.projection().projectDocs?.documentTip;
    assert.equal(typeof canonical, "string");
    assert.equal(tip, fixture.integration.revision);
    assert.notEqual(tip, canonical);
    assert.equal(runtime.projection().finalVerification?.current?.state, "current");
    assert.equal(runtime.projection().finalVerification?.current?.targetRevision, canonical);
    const selected = runtime.selectProjectHandoff("apply_to_project", {
      integrationRevision: tip!,
      integrationBranch: fixture.integration.integrationBranch,
      appliedToProject: true,
    }, "handoff-docs");
    assert.equal(selected.status, "completed");
    assert.equal(selected.finalVerification?.current?.state, "current");
    assert.equal(selected.finalVerification?.current?.targetRevision, canonical);
    await fixture.integration.applyToProject();
    assert.equal(existsSync(join(fixture.project, "docs", "project", "STATE.md")), true);
    assert.equal(existsSync(join(fixture.project, "docs", "project", "README.md")), true);
    assert.equal(existsSync(join(fixture.project, "AGENTS.md")), true);
    assert.equal(existsSync(join(fixture.project, "CLAUDE.md")), true);
  } finally {
    store.close();
    evidenceStore.close();
    fixture.close();
  }
});

function event(
  runId: string,
  type: string,
  actor: SchedulerActor,
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  return {
    runId,
    type: type as "run.initialized",
    occurredAt: WHEN,
    actor,
    idempotencyKey,
    payload,
  };
}

function runner(): SchedulerActor {
  return { role: "runner", id: "build-runtime" };
}

function architect(): SchedulerActor {
  return { role: "architect", id: "architect_1" };
}

function seedStamped(store: SqliteSchedulerStore, runId: string): void {
  store.append(event(runId, "project_docs.policy_configured", runner(), "project-docs-policy", { version: 1 }));
  store.append(event(runId, "run.initialized", runner(), "run-initialized", {}));
  store.append(event(runId, "run.policy_configured", runner(), "run-policy", { runPolicy: "finish" }));
}

function seedPlanOnly(store: SqliteSchedulerStore, runId: string): void {
  store.append(event(runId, "project_docs.policy_configured", runner(), "project-docs-policy", { version: 1 }));
  store.append(event(runId, "run.initialized", runner(), "run-initialized", {}));
  store.append(event(runId, "run.policy_configured", runner(), "run-policy", { runPolicy: "plan_only" }));
  store.append(event(runId, "plan.created", architect(), "plan", { revision: 1, tasks: [] }));
}

function integratingTask(id: string): BuildTask {
  return {
    id,
    objective: id,
    dependencies: [],
    status: "integrating",
    requiredCapabilities: ["code"],
    attempt: 1,
    changeSetId: `cs_${id}`,
  };
}

function commitDoc(
  store: SqliteSchedulerStore,
  runId: string,
  path: string,
  requestId: string,
  facts: {
    readme: boolean;
    agentsMarkedSection: boolean;
    claudePointer: boolean;
    parent: string;
    commit: string;
  },
): void {
  store.append(event(runId, "project_doc.requested", architect(), requestId, {
    requestId,
    path,
    contentArtifactHash: HASH,
    contentBytes: 12,
    summary: `Write ${path}`,
  }));
  store.append(event(runId, "project_doc.committed", runner(), `project-doc-committed:${requestId}`, {
    requestId,
    path,
    commit: facts.commit,
    parent: facts.parent,
    head: facts.commit,
    readme: facts.readme,
    agentsMarkedSection: facts.agentsMarkedSection,
    claudePointer: facts.claudePointer,
  }));
}

function entryPointWrites(): Array<{ path: string; content: string }> {
  return [
    { path: "docs/project/README.md", content: DEFAULT_README_TEMPLATE },
    { path: "AGENTS.md", content: DEFAULT_AGENTS_SECTION_BODY },
    { path: "CLAUDE.md", content: CLAUDE_POINTER_LINE },
    { path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE },
  ];
}

async function invoke(
  request: ArchitectActionRequest,
  name: string,
  argumentsValue: unknown,
): Promise<void> {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: `${name}:${createHash("sha256").update(JSON.stringify(argumentsValue)).digest("hex").slice(0, 12)}`,
    name,
    arguments: argumentsValue,
  };
  const result = await request.tools.invoke(call, request.context);
  assert.equal(result.isError, false, result.error?.message ?? `${name} failed`);
}

function hashTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stats = statSync(path);
      hash.update(name);
      if (stats.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest("hex");
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}

async function requestCount(cwd: string, baseline: string, requestId: string): Promise<number> {
  const body = (await runGit({
    cwd,
    args: ["log", "--format=%B", `${baseline}..HEAD`],
  })).stdout;
  const needle = `AIBoard-Doc-Request: ${requestId}`;
  return body.split(/\r?\n/).filter((line) => line.trim() === needle).length;
}

async function openGitFixture(label: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-doc-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  const runId = `run_${label}`;
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const workspaces = new WorkspaceManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const evidence = await artifacts.put(Buffer.from("mechanical verification evidence"), "text/plain", "Fixture evidence");
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return {
    root,
    project,
    state,
    runId,
    baseline,
    workspaces,
    artifacts,
    evidence,
    integration,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function changeSetForFile(
  fixture: Awaited<ReturnType<typeof openGitFixture>>,
  taskId: string,
  path: string,
  content: string,
) {
  const workspace = await fixture.workspaces.createTaskWorkspace(taskId);
  const parent = path.split("/").slice(0, -1);
  if (parent.length > 0) mkdirSync(join(workspace.path, ...parent), { recursive: true });
  writeFileSync(join(workspace.path, path), content);
  const taskCommit = await fixture.workspaces.commitTask(taskId, `Add ${path}`);
  return await createChangeSet({
    workspacePath: workspace.path,
    taskCommit,
    artifacts: fixture.artifacts,
    evidenceArtifactHashes: [fixture.evidence.hash],
  });
}

async function integrateFile(
  fixture: Awaited<ReturnType<typeof openGitFixture>>,
  taskId: string,
  path: string,
  content: string,
) {
  const workspace = await fixture.workspaces.createTaskWorkspace(taskId);
  mkdirSync(join(workspace.path, ...path.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(workspace.path, path), content);
  const taskCommit = await fixture.workspaces.commitTask(taskId, `Add ${path}`);
  const changeSet = await createChangeSet({
    workspacePath: workspace.path,
    taskCommit,
    artifacts: fixture.artifacts,
    evidenceArtifactHashes: [fixture.evidence.hash],
  });
  const result = await fixture.integration.integrate(changeSet);
  return { ...result, changeSet };
}

function emptyChangeSet(
  fixture: Awaited<ReturnType<typeof openGitFixture>>,
  id: string,
): ChangeSet {
  return {
    id,
    runId: fixture.runId,
    taskId: id,
    baselineRevision: fixture.baseline.revision,
    taskRevision: fixture.baseline.revision,
    commits: [],
    changedPaths: [],
    diffArtifactHash: HASH,
    evidenceArtifactHashes: [],
    externalEffects: [],
    guidanceIds: [],
    memoryIds: [],
    unresolvedConcerns: [],
  };
}
