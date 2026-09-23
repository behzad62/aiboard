import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, NativeTool } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { BrowserBackend } from "../src/browser-tools.js";
import type { EvidenceStore } from "../src/evidence-store.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import {
  createArchitectInspectionBroker,
  PlanOnlyInspectionRuntime,
} from "../src/native-architect-runtime.js";
import {
  createPlanCriticInspectionBroker,
} from "../src/native-plan-critic-runtime.js";
import {
  createVerifierExpectationsBroker,
  createVerifierReviewBroker,
} from "../src/native-verifier-runtime.js";
import { createSubmitPlanCritiqueTool } from "../src/plan-critique-tools.js";
import type { PlanCritiqueAuthority } from "../src/plan-critique-authority.js";
import type { ProjectMemoryStore } from "../src/project-memory.js";
import {
  ARCHITECT_LIFECYCLE_TOOLS,
  READER_AUTHORITY_FORBIDDEN_TOOLS,
  ROLE_CAPABILITY_BROKERS,
  assertRoleToolSurface,
  isCatalogToolName,
  isMcpToolName,
  mcpToolAdmitted,
  roleAllowList,
  roleToolSurface,
  staticToolAdmitted,
  type RoleCapabilityBroker,
  type RoleCapabilityRole,
} from "../src/role-capabilities.js";
import type { SchedulerStore } from "../src/scheduler-store.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import type { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import type { ToolInvocationLedger } from "../src/tool-ledger.js";
import {
  createRecordVerificationExpectationsTool,
  createSubmitVerifierVerdictTool,
} from "../src/verifier-tools.js";
import type { VerifierVerdictAuthority } from "../src/verifier-verdict-authority.js";
import { runWorkerTask } from "../src/worker-runtime.js";
import type { TaskWorkspace, WorkspaceManager } from "../src/workspace-manager.js";

const ARCHITECT_INSPECTION_REQUIRED = [
  "archive_project_memory",
  "artifact.read",
  "code.definition",
  "code.diagnostics",
  "code.references",
  "code.workspace_symbols",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.remotes",
  "git.show",
  "git.status",
  "inspect_evidence",
  "list_memory_proposals",
  "list_skills",
  "promote_project_memory",
  "propose_project_memory",
  "read_skill",
  "recall_project_memory",
  "repo.manifest",
  "repo.map",
  "research.fetch",
  "search_session_history",
] as const;

const ARCHITECT_INSPECTION_FULL = [
  "archive_project_memory",
  "artifact.read",
  "browser.click",
  "browser.close",
  "browser.drag",
  "browser.events",
  "browser.fill",
  "browser.navigate",
  "browser.open",
  "browser.screenshot",
  "browser.snapshot",
  "browser.wheel",
  "code.definition",
  "code.diagnostics",
  "code.references",
  "code.workspace_symbols",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.remotes",
  "git.show",
  "git.status",
  "inspect_evidence",
  "list_memory_proposals",
  "list_skills",
  "promote_project_memory",
  "propose_project_memory",
  "read_skill",
  "recall_project_memory",
  "repo.manifest",
  "repo.map",
  "research.fetch",
  "search_session_history",
] as const;

const ARCHITECT_PLAN_ONLY_REQUIRED = [
  "artifact.read",
  "code.definition",
  "code.diagnostics",
  "code.references",
  "code.workspace_symbols",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.remotes",
  "git.show",
  "git.status",
  "inspect_evidence",
  "list_memory_proposals",
  "list_skills",
  "read_skill",
  "recall_project_memory",
  "repo.manifest",
  "repo.map",
  "research.fetch",
  "search_session_history",
] as const;

const ARCHITECT_PLAN_ONLY_FULL = [
  "artifact.read",
  "browser.events",
  "browser.navigate",
  "browser.open",
  "browser.screenshot",
  "browser.snapshot",
  "code.definition",
  "code.diagnostics",
  "code.references",
  "code.workspace_symbols",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.remotes",
  "git.show",
  "git.status",
  "inspect_evidence",
  "list_memory_proposals",
  "list_skills",
  "read_skill",
  "recall_project_memory",
  "repo.manifest",
  "repo.map",
  "research.fetch",
  "search_session_history",
] as const;

const VERIFIER_INSPECTION_REQUIRED = [
  "artifact.read",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.show",
  "git.status",
  "inspect_evidence",
] as const;

const VERIFIER_INSPECTION_FULL = [
  ...VERIFIER_INSPECTION_REQUIRED,
  "submit_verifier_verdict",
] as const;

const VERIFIER_EXPECTATIONS = [
  "artifact.read",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.status",
  "inspect_evidence",
  "record_verification_expectations",
] as const;

const PLAN_CRITIC = [
  "artifact.read",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.stat",
  "git.diff",
  "git.log",
  "git.show",
  "git.status",
  "submit_plan_critique",
] as const;

const WORKER_REQUIRED = [
  "artifact.read",
  "code.definition",
  "code.diagnostics",
  "code.references",
  "code.workspace_symbols",
  "fs.delete",
  "fs.list",
  "fs.move",
  "fs.patch",
  "fs.read",
  "fs.search",
  "fs.stat",
  "fs.write",
  "git.commit",
  "git.diff",
  "git.log",
  "git.push",
  "git.remotes",
  "git.show",
  "git.status",
  "process.run",
  "repo.manifest",
  "repo.map",
  "research.fetch",
  "search_session_history",
  "spawn_readonly_subagent",
  "spawn_subagent",
  "submit_task",
] as const;

const WORKER_FULL = [
  "archive_project_memory",
  "artifact.read",
  "ask_architect",
  "browser.click",
  "browser.close",
  "browser.drag",
  "browser.events",
  "browser.fill",
  "browser.navigate",
  "browser.open",
  "browser.screenshot",
  "browser.snapshot",
  "browser.wheel",
  "challenge_guidance",
  "code.definition",
  "code.diagnostics",
  "code.references",
  "code.workspace_symbols",
  "fs.delete",
  "fs.list",
  "fs.move",
  "fs.patch",
  "fs.read",
  "fs.search",
  "fs.stat",
  "fs.write",
  "git.commit",
  "git.diff",
  "git.log",
  "git.push",
  "git.remotes",
  "git.show",
  "git.status",
  "inspect_evidence",
  "list_memory_proposals",
  "list_skills",
  "process.list",
  "process.poll",
  "process.run",
  "process.signal",
  "process.start",
  "promote_project_memory",
  "propose_project_memory",
  "read_skill",
  "recall_project_memory",
  "repo.manifest",
  "repo.map",
  "request_replan",
  "research.fetch",
  "run_evidence_command",
  "search_session_history",
  "spawn_readonly_subagent",
  "spawn_subagent",
  "submit_task",
] as const;

const DERIVED: readonly {
  role: RoleCapabilityRole;
  broker: RoleCapabilityBroker;
  required: readonly string[];
  full: readonly string[];
}[] = [
  { role: "architect", broker: "inspection", required: ARCHITECT_INSPECTION_REQUIRED, full: ARCHITECT_INSPECTION_FULL },
  { role: "architect", broker: "planOnly", required: ARCHITECT_PLAN_ONLY_REQUIRED, full: ARCHITECT_PLAN_ONLY_FULL },
  { role: "verifier", broker: "inspection", required: VERIFIER_INSPECTION_REQUIRED, full: VERIFIER_INSPECTION_FULL },
  { role: "verifier", broker: "expectations", required: VERIFIER_EXPECTATIONS, full: VERIFIER_EXPECTATIONS },
  { role: "plan-critic", broker: "inspection", required: PLAN_CRITIC, full: PLAN_CRITIC },
  { role: "worker", broker: "task", required: WORKER_REQUIRED, full: WORKER_FULL },
];

test("every role broker has an exact derived allow-list in both directions", () => {
  assert.deepEqual(
    ROLE_CAPABILITY_BROKERS.map((entry) => `${entry.role}:${entry.broker}`),
    DERIVED.map((entry) => `${entry.role}:${entry.broker}`),
  );
  for (const entry of DERIVED) {
    assertRoleToolSurface(entry.role, entry.broker, entry.required);
    assertRoleToolSurface(entry.role, entry.broker, entry.full);
    assert.deepEqual([...roleAllowList(entry.role, entry.broker)], [...entry.full]);
    assert.deepEqual([...roleToolSurface(entry.role, entry.broker).tools], [...entry.required]);
    const optional = entry.full.filter((name) => !entry.required.includes(name));
    assert.deepEqual([...roleToolSurface(entry.role, entry.broker).optionalTools], optional);
  }
});

test("assertRoleToolSurface throws when a required tool is removed or an unlisted tool is admitted", () => {
  for (const entry of DERIVED) {
    assert.throws(
      () => assertRoleToolSurface(entry.role, entry.broker, [...entry.required, "unlisted.tool"]),
      new RegExp(
        `Role ${entry.role} broker ${entry.broker} registered tool unlisted\\.tool is not on the allow-list\\.`,
      ),
    );
    assert.throws(
      () => assertRoleToolSurface(
        entry.role,
        entry.broker,
        entry.required.filter((name) => name !== "artifact.read"),
      ),
      new RegExp(
        `Role ${entry.role} broker ${entry.broker} required tool artifact\\.read is missing\\.`,
      ),
    );
  }
});

test("MCP admission is an explicit policy separate from the static allow-list", () => {
  assert.equal(isMcpToolName("mcp.audit.read"), true);
  assert.equal(isMcpToolName("fs.read"), false);
  assert.equal(mcpToolAdmitted("all", { readOnly: false, effect: "external" }), true);
  assert.equal(mcpToolAdmitted("none", { readOnly: true, effect: "none" }), false);
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { readOnly: true, effect: "external" }), true);
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { readOnly: false, effect: "external" }), false);
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { readOnly: true, effect: "workspace" }), false);
  assert.equal(roleToolSurface("architect", "inspection").mcpPolicy, "all");
  assert.equal(roleToolSurface("architect", "planOnly").mcpPolicy, "read-only-non-workspace");
  assert.equal(roleToolSurface("verifier", "inspection").mcpPolicy, "none");
  assert.equal(roleToolSurface("verifier", "expectations").mcpPolicy, "none");
  assert.equal(roleToolSurface("plan-critic", "inspection").mcpPolicy, "none");
  assert.equal(roleToolSurface("worker", "task").mcpPolicy, "all");
  assertRoleToolSurface("architect", "inspection", [...ARCHITECT_INSPECTION_REQUIRED, "mcp.audit.write"]);
  assert.throws(
    () => assertRoleToolSurface("verifier", "inspection", [...VERIFIER_INSPECTION_REQUIRED, "mcp.audit.read"]),
    /Role verifier broker inspection MCP tool mcp\.audit\.read is not admitted by policy none\./,
  );
  assert.throws(
    () => assertRoleToolSurface("plan-critic", "inspection", [...PLAN_CRITIC, "mcp.audit.read"]),
    /policy none/,
  );
});

test("verifier and plan critic lists exclude commit, integrate, complete, plan-altering, and task-review tools", () => {
  for (const entry of DERIVED.filter((item) => item.role === "verifier" || item.role === "plan-critic")) {
    for (const forbidden of READER_AUTHORITY_FORBIDDEN_TOOLS) {
      assert.equal(entry.full.includes(forbidden), false, `${entry.role} ${entry.broker} lists ${forbidden}`);
      assert.equal(staticToolAdmitted(entry.role, entry.broker, forbidden), false);
    }
  }
});

test("Architect inspection does not carry lifecycle tools that belong to createArchitectTools", () => {
  for (const name of ARCHITECT_LIFECYCLE_TOOLS) {
    assert.equal(staticToolAdmitted("architect", "inspection", name), false);
    assert.equal(staticToolAdmitted("architect", "planOnly", name), false);
  }
  assert.equal(isCatalogToolName("review_task"), false);
  assert.equal(isCatalogToolName("fs.read"), true);
  assert.equal(isCatalogToolName("fixture.architect.inspect"), false);
  assert.equal(staticToolAdmitted("worker", "task", "fs.write"), true);
  assert.equal(staticToolAdmitted("architect", "inspection", "fs.write"), false);
  assert.equal(staticToolAdmitted("architect", "planOnly", "browser.snapshot"), true);
  assert.equal(staticToolAdmitted("architect", "planOnly", "browser.click"), false);
});

test("constructed brokers match the derived surfaces and an unlisted probe fails at registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "a1-role-capabilities-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const base = architectInput(root, artifacts);
    const inspection = createArchitectInspectionBroker(base);
    assert.deepEqual(names(inspection), [...ARCHITECT_INSPECTION_REQUIRED]);
    const withBrowser = createArchitectInspectionBroker({ ...base, browserBackend: browserStub() });
    assert.deepEqual(names(withBrowser), [...ARCHITECT_INSPECTION_FULL]);
    assert.deepEqual(
      names(new PlanOnlyInspectionRuntime(withBrowser)),
      [...ARCHITECT_PLAN_ONLY_FULL],
    );
    assert.deepEqual(
      names(new PlanOnlyInspectionRuntime(inspection)),
      [...ARCHITECT_PLAN_ONLY_REQUIRED],
    );
    assert.throws(
      () => createArchitectInspectionBroker({ ...base, probeTools: [probeTool("probe.unlisted")] }),
      /Role architect broker inspection registered tool probe\.unlisted is not on the allow-list\./,
    );
    assert.throws(
      () => new PlanOnlyInspectionRuntime(inspection, { probeToolNames: ["probe.unlisted"] }),
      /Role architect broker planOnly registered tool probe\.unlisted is not on the allow-list\./,
    );

    const verifier = createVerifierReviewBroker(inspectionInput(root, artifacts));
    assert.deepEqual(names(verifier), [...VERIFIER_INSPECTION_REQUIRED]);
    const verdict = createVerifierReviewBroker({
      ...inspectionInput(root, artifacts),
      lifecycleTool: createSubmitVerifierVerdictTool({
        authority: {} as VerifierVerdictAuthority,
        runId: "run",
        reviewId: "review",
        targetRevision: "a".repeat(40),
        runtimeId: "verifier",
        sessionId: "session",
      }),
    });
    assert.deepEqual(names(verdict), [...VERIFIER_INSPECTION_FULL]);
    assert.throws(
      () => createVerifierReviewBroker({
        ...inspectionInput(root, artifacts),
        probeTools: [probeTool("probe.unlisted")],
      }),
      /Role verifier broker inspection registered tool probe\.unlisted is not on the allow-list\./,
    );
    const expectations = createVerifierExpectationsBroker({
      ...inspectionInput(root, artifacts),
      excludeToolNames: ["git.diff", "git.log", "git.show"],
      lifecycleTool: createRecordVerificationExpectationsTool({
        authority: {} as VerifierVerdictAuthority,
        runId: "run",
        reviewId: "review",
        targetRevision: "a".repeat(40),
        baselineRevision: "b".repeat(40),
        runtimeId: "verifier",
        sessionId: "session",
        criteria: [],
      }),
    });
    assert.deepEqual(names(expectations), [...VERIFIER_EXPECTATIONS]);
    assert.throws(
      () => createVerifierExpectationsBroker({
        ...inspectionInput(root, artifacts),
        lifecycleTool: createRecordVerificationExpectationsTool({
          authority: {} as VerifierVerdictAuthority,
          runId: "run",
          reviewId: "review",
          targetRevision: "a".repeat(40),
          baselineRevision: "b".repeat(40),
          runtimeId: "verifier",
          sessionId: "session",
          criteria: [],
        }),
        probeTools: [probeTool("probe.unlisted")],
      }),
      /Role verifier broker expectations registered tool probe\.unlisted is not on the allow-list\./,
    );

    const critic = createPlanCriticInspectionBroker({
      ...inspectionInput(root, artifacts),
      evidenceStore: undefined,
      lifecycleTool: createSubmitPlanCritiqueTool({
        authority: {} as PlanCritiqueAuthority,
        runId: "run",
        critiqueId: "critique",
        planRevision: 1,
        runtimeId: "critic",
        sessionId: "session",
        tasks: {},
      }),
    });
    assert.deepEqual(names(critic), [...PLAN_CRITIC]);
    assert.equal(names(critic).includes("inspect_evidence"), false);
    assert.throws(
      () => createPlanCriticInspectionBroker({
        ...inspectionInput(root, artifacts),
        evidenceStore: undefined,
        lifecycleTool: createSubmitPlanCritiqueTool({
          authority: {} as PlanCritiqueAuthority,
          runId: "run",
          critiqueId: "critique",
          planRevision: 1,
          runtimeId: "critic",
          sessionId: "session",
          tasks: {},
        }),
        probeTools: [probeTool("probe.unlisted")],
      }),
      /Role plan-critic broker inspection registered tool probe\.unlisted is not on the allow-list\./,
    );

    assert.deepEqual(await workerNames(root, artifacts, false), [...WORKER_REQUIRED]);
    assert.deepEqual(await workerNames(root, artifacts, true), [...WORKER_FULL]);
    await assert.rejects(
      () => workerNames(root, artifacts, false, [probeTool("probe.unlisted")]),
      /Role worker broker task registered tool probe\.unlisted is not on the allow-list\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function names(runtime: { definitions(): readonly { name: string }[] }): string[] {
  return runtime.definitions().map((definition) => definition.name).sort((left, right) => left.localeCompare(right));
}

function probeTool(name: string): NativeTool<unknown> {
  return {
    definition: {
      name,
      description: "Unlisted registration probe",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [], isError: false }),
  };
}

function architectInput(root: string, artifacts: ArtifactStore) {
  return {
    permissionProfile: "project" as const,
    projectRoot: root,
    artifacts,
    sessions: {} as SqliteAgentSessionStore,
    evidenceStore: {} as EvidenceStore,
    skillCatalog: new SkillCatalog({ projectRoot: root }),
    memoryStore: {} as ProjectMemoryStore,
    projectId: "project",
    runId: "run",
    clock: () => "2026-09-23T00:00:00.000Z",
  };
}

function inspectionInput(root: string, artifacts: ArtifactStore) {
  return {
    workspacePath: root,
    artifacts,
    evidenceStore: {} as EvidenceStore,
    runId: "run",
    clock: () => "2026-09-23T00:00:00.000Z",
  };
}

function browserStub(): BrowserBackend {
  return {
    open: async () => ({ url: "https://example.test/", title: "Example" }),
    navigate: async () => ({ url: "https://example.test/", title: "Example" }),
    snapshot: async () => ({ url: "https://example.test/", title: "Example", text: "safe", html: "<p>safe</p>" }),
    click: async () => undefined,
    fill: async () => undefined,
    wheel: async () => undefined,
    drag: async () => undefined,
    screenshot: async () => Buffer.from("png"),
    events: async () => ({ console: [], network: [] }),
    close: async () => undefined,
    closeRun: async () => undefined,
    closeAll: async () => undefined,
  };
}

async function workerNames(
  root: string,
  artifacts: ArtifactStore,
  full: boolean,
  probe: readonly NativeTool<unknown>[] = [],
): Promise<string[]> {
  const seen: string[] = [];
  const model: AgentModel = {
    async complete(request) {
      seen.push(...request.tools.map((tool) => tool.name));
      return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
    },
  };
  const workspace: TaskWorkspace = {
    runId: "run",
    taskId: "task",
    workspaceId: "workspace",
    path: root,
    branch: "refs/heads/aiboard/tasks/task",
    baselineRevision: "a".repeat(40),
  };
  await runWorkerTask({
    model,
    runId: "run",
    sessionId: "session",
    taskId: "task",
    actorId: "worker",
    permissionProfile: "project",
    workspace,
    workspaceManager: {} as WorkspaceManager,
    artifacts,
    ledger: {} as ToolInvocationLedger,
    sessions: {
      events: () => [],
      create: async () => undefined,
      checkpoint: async () => undefined,
      suspend: () => undefined,
    } as unknown as SqliteAgentSessionStore,
    initialMessages: [{ id: "task", role: "user", content: "Inspect." }],
    ...(probe.length > 0 ? { toolSurfaceProbe: probe } : {}),
    ...(full
      ? {
          browserBackend: browserStub(),
          evidenceStore: {} as EvidenceStore,
          skillCatalog: new SkillCatalog({ projectRoot: root }),
          memoryStore: {} as ProjectMemoryStore,
          projectId: "project",
          schedulerStore: { readRun: () => [] } as unknown as SchedulerStore,
          managedProcesses: {} as ManagedProcessService,
        }
      : {}),
  });
  return seen.sort((left, right) => left.localeCompare(right));
}
