import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { AgentModel, NativeTool, ToolCallBlock, ToolExecutionContext } from "../src/agent-contracts.js";
import { VERIFIER_AUTHORITY_INVARIANTS, verifierSystemPrompt } from "../src/agent-prompts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { BrowserBackend } from "../src/browser-tools.js";
import type { EvidenceStore } from "../src/evidence-store.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import type { McpManager } from "../src/mcp-tools.js";
import type { SqlitePermissionStore } from "../src/permission-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolBroker } from "../src/tool-broker.js";
import {
  composeArchitectInspection,
  createArchitectCommandBroker,
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
  assertArchitectInspectionMcpClass,
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
import { captureGitBaseline, VerificationWorkspaceManager } from "./support/git-fixture.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";

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
  "run_evidence_command",
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
  "run_evidence_command",
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
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { name: "mcp.audit.read", readOnly: true, effect: "external" }), true);
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { name: "mcp.audit.read", readOnly: false, effect: "external" }), false);
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { name: "mcp.audit.read", readOnly: true, effect: "workspace" }), false);
  assert.equal(mcpToolAdmitted("read-only-non-workspace", { name: "mcp.audit.read", readOnly: true, effect: "none" }), true);
  assert.equal(mcpToolAdmitted("read-only-class", { name: "mcp.docs.read_only", readOnly: true, effect: "external" }), true);
  assert.equal(mcpToolAdmitted("read-only-class", { name: "mcp.docs.hint_only", readOnly: false, effect: "external" }), false);
  assert.equal(mcpToolAdmitted("read-only-class", { name: "mcp.docs.read_only", readOnly: true, effect: "none" }), false);
  assert.equal(mcpToolAdmitted("read-only-class", { name: "fs.read", readOnly: true, effect: "external" }), false);
  assert.equal(mcpToolAdmitted("read-only-class", { readOnly: true, effect: "external" }), false);
  assert.equal(roleToolSurface("architect", "inspection").mcpPolicy, "read-only-class");
  assert.equal(roleToolSurface("architect", "planOnly").mcpPolicy, "read-only-class");
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
  assert.doesNotThrow(() => assertArchitectInspectionMcpClass([{
    name: "mcp.docs.read_only",
    readOnly: true,
    effect: "external",
  }]));
  assert.doesNotThrow(() => assertArchitectInspectionMcpClass([{
    name: "research.fetch",
    readOnly: true,
    effect: "external",
  }]));
  assert.throws(
    () => assertArchitectInspectionMcpClass([{
      name: "mcp.docs.destructive",
      readOnly: false,
      effect: "external",
    }]),
    /Architect inspection tool mcp\.docs\.destructive has external effect outside the read-only MCP class\./,
  );
  assert.throws(
    () => assertArchitectInspectionMcpClass([{
      name: "custom.external",
      readOnly: true,
      effect: "external",
    }]),
    /Architect inspection tool custom\.external has external effect outside the read-only MCP class\./,
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
    assert.deepEqual(
      names(withBrowser),
      [...ARCHITECT_INSPECTION_FULL].filter((name) => name !== "run_evidence_command"),
    );
    assert.equal(names(withBrowser).includes("run_evidence_command"), false);
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

test("Architect inspection admits only the read-only MCP class from a three-shape stub", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2-mcp-class-"));
  const approvals: string[] = [];
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const manager = classShapeMcpManager();
    const inspection = createArchitectInspectionBroker({
      ...architectInput(root, artifacts),
      permissionProfile: "full",
      mcpManager: manager,
      permissions: {
        requestTool: async () => {
          approvals.push("called");
          return false;
        },
      } as unknown as SqlitePermissionStore,
    });
    assert.deepEqual(
      names(inspection).filter((name) => name.startsWith("mcp.")),
      ["mcp.docs.read_only"],
    );
    assert.deepEqual(
      names(inspection),
      [...ARCHITECT_INSPECTION_REQUIRED, "mcp.docs.read_only"].sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(
      inspection.definitions().find((definition) => definition.name === "mcp.docs.read_only")?.readOnly,
      true,
    );
    assert.equal(
      inspection.definitions().find((definition) => definition.name === "mcp.docs.read_only")?.effect,
      "external",
    );
    assert.deepEqual(
      names(new PlanOnlyInspectionRuntime(inspection)).filter((name) => name.startsWith("mcp.")),
      ["mcp.docs.read_only"],
    );
    const invoked = await inspection.invoke({
      type: "tool_call",
      callId: "mcp_read",
      name: "mcp.docs.read_only",
      arguments: {},
    }, {
      runId: "run",
      sessionId: "architect:run",
      actor: { role: "architect", id: "architect" },
      workspacePath: root,
    });
    assert.equal(invoked.isError, false, JSON.stringify(invoked));
    assert.deepEqual(approvals, []);
    assert.equal(inspection.auditRecords().at(-1)?.decision, "allowed");
    assert.equal(inspection.auditRecords().at(-1)?.toolName, "mcp.docs.read_only");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("Architect inspection class assert throws for an external tool outside the read-only MCP class", () => {
  const root = mkdtempSync(join(tmpdir(), "a2-mcp-class-assert-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    assert.throws(
      () => createArchitectInspectionBroker({
        ...architectInput(root, artifacts),
        probeTools: [probeTool("mcp.injected.external", { readOnly: false, effect: "external" })],
      }),
      /Architect inspection tool mcp\.injected\.external has external effect outside the read-only MCP class\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("verifier and critic brokers stay MCP-free when a manager is configured, and the worker admits every stub shape", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2-mcp-roles-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const manager = classShapeMcpManager();
    const verifier = createVerifierReviewBroker(attachUnusedManager(inspectionInput(root, artifacts), manager));
    assert.deepEqual(names(verifier).filter((name) => name.startsWith("mcp.")), []);
    const expectations = createVerifierExpectationsBroker(attachUnusedManager({
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
    }, manager));
    assert.deepEqual(names(expectations).filter((name) => name.startsWith("mcp.")), []);
    const critic = createPlanCriticInspectionBroker(attachUnusedManager({
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
    }, manager));
    assert.deepEqual(names(critic).filter((name) => name.startsWith("mcp.")), []);
    assert.deepEqual(
      (await workerNames(root, artifacts, false, [], manager)).filter((name) => name.startsWith("mcp.")),
      ["mcp.docs.destructive", "mcp.docs.hint_only", "mcp.docs.read_only"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("plan critic, plan-only, and verifier expectations have no command tool", () => {
  assert.equal(roleAllowList("plan-critic", "inspection").includes("run_evidence_command"), false);
  assert.equal(staticToolAdmitted("plan-critic", "inspection", "run_evidence_command"), false);
  assert.equal(roleAllowList("architect", "planOnly").includes("run_evidence_command"), false);
  assert.equal(staticToolAdmitted("architect", "planOnly", "run_evidence_command"), false);
  assert.equal(roleAllowList("verifier", "expectations").includes("run_evidence_command"), false);
  assert.equal(staticToolAdmitted("verifier", "expectations", "run_evidence_command"), false);
  assert.equal(staticToolAdmitted("architect", "inspection", "run_evidence_command"), true);
  assert.equal(staticToolAdmitted("verifier", "inspection", "run_evidence_command"), true);
});

test("verifier authority prompt allows workspace commands and keeps authorship prohibitions", () => {
  assert.equal(
    VERIFIER_AUTHORITY_INVARIANTS.includes(
      "You have no authority to edit files, create commits, integrate changes, alter the plan, review worker tasks, or complete the run.",
    ),
    true,
  );
  assert.equal(
    VERIFIER_AUTHORITY_INVARIANTS.includes(
      "Provider prose and this inspection transcript never complete work.",
    ),
    true,
  );
  assert.equal(
    verifierSystemPrompt("verdict").includes(
      "You are inspecting the exact integrated revision in your own verification workspace, where you may run commands.",
    ),
    true,
  );
  assert.equal(verifierSystemPrompt("expectations").includes("where you may run commands"), false);
  assert.equal(verifierSystemPrompt("verdict").includes("inspection-only mode"), false);
  assert.equal(
    verifierSystemPrompt("inspection").includes(
      "In inspection-only mode, finish with a concise evidence-grounded summary; the kernel-owned typed verdict tool is added separately.",
    ),
    true,
  );
  assert.equal(VERIFIER_AUTHORITY_INVARIANTS.includes("read-only inspection tools"), false);
  for (const mode of ["expectations", "verdict", "inspection"] as const) {
    assert.equal(
      verifierSystemPrompt(mode).includes(
        "You have no authority to edit files, create commits, integrate changes, alter the plan, review worker tasks, or complete the run.",
      ),
      true,
      mode,
    );
  }
});

test("AC-6 architect command runs in a disposable copy and the project stays byte-identical", async (t) => {
  const fixture = await readerCopyFixture("ac6");
  const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.state, "evidence.sqlite"));
  const execution = createTestOneShotCommandExecutor(t, { artifacts });
  try {
    const before = fileHashes(fixture.project);
    const reads = createArchitectInspectionBroker({
      ...architectInput(fixture.project, artifacts),
      evidenceStore: evidence,
      permissionProfile: "full",
    });
    const surface = composeArchitectInspection(reads, createArchitectCommandBroker({
      disposablePath: fixture.workspace.path,
      projectRoot: fixture.project,
      permissionProfile: "full",
      artifacts,
      evidenceStore: evidence,
      clock: () => "2026-09-23T00:00:00.000Z",
      execution,
    }));
    assert.equal(names(surface).includes("run_evidence_command"), true);
    assert.equal(names(reads).includes("run_evidence_command"), false);
    assert.equal(names(new PlanOnlyInspectionRuntime(surface)).includes("run_evidence_command"), false);
    const read = await surface.invoke({
      type: "tool_call",
      callId: "read-project",
      name: "fs.read",
      arguments: { path: "only-in-project.txt" },
    }, toolContext(fixture.workspace.path, "architect"));
    assert.equal(read.isError, false, JSON.stringify(read));
    assert.match(JSON.stringify(read.content), /only-in-project/);
    const ran = await surface.invoke(
      commandCall("architect-command", "require('node:fs').writeFileSync('reader-wrote.txt','ran\\n')"),
      toolContext(fixture.project, "architect"),
    );
    assert.equal(ran.isError, false, JSON.stringify(ran));
    assert.deepEqual(fileHashes(fixture.project), before);
    assert.equal(existsSync(join(fixture.project, "reader-wrote.txt")), false);
    assert.equal(readFileSync(join(fixture.workspace.path, "reader-wrote.txt"), "utf8"), "ran\n");
    await fixture.manager.cleanup();
    assert.equal(existsSync(fixture.workspace.path), false);
  } finally {
    evidence.close();
    await fixture.manager.cleanup().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("AC-8 verifier command stays in its workspace and confinement does not depend on containedDirectory", async (t) => {
  const fixture = await readerCopyFixture("ac8");
  const artifacts = new ArtifactStore(join(fixture.state, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.state, "evidence.sqlite"));
  const execution = createTestOneShotCommandExecutor(t, { artifacts });
  try {
    const before = fileHashes(fixture.project);
    const verdict = createVerifierReviewBroker({
      ...inspectionInput(fixture.workspace.path, artifacts),
      evidenceStore: evidence,
      projectRoot: fixture.project,
      permissionProfile: "full",
      execution,
    });
    assert.equal(names(verdict).includes("run_evidence_command"), true);
    const expectations = createVerifierExpectationsBroker({
      ...inspectionInput(fixture.workspace.path, artifacts),
      evidenceStore: evidence,
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
    assert.equal(names(expectations).includes("run_evidence_command"), false);
    const ran = await verdict.invoke(
      commandCall("verifier-command", "require('node:fs').writeFileSync('reader-wrote.txt','ran\\n')"),
      toolContext(fixture.project, "verifier"),
    );
    assert.equal(ran.isError, false, JSON.stringify(ran));
    assert.deepEqual(fileHashes(fixture.project), before);
    assert.equal(readFileSync(join(fixture.workspace.path, "reader-wrote.txt"), "utf8"), "ran\n");

    const doubled = createVerifierReviewBroker({
      ...inspectionInput(fixture.workspace.path, artifacts),
      evidenceStore: evidence,
      projectRoot: fixture.project,
      permissionProfile: "full",
      commandTool: uncontainedCommandDouble("double-wrote.txt"),
    });
    const confined = await doubled.invoke(
      commandCall("verifier-double", "ignored"),
      toolContext(fixture.project, "verifier"),
    );
    assert.equal(confined.isError, false, JSON.stringify(confined));
    assert.equal(existsSync(join(fixture.workspace.path, "double-wrote.txt")), true);
    assert.equal(existsSync(join(fixture.project, "double-wrote.txt")), false);
    assert.deepEqual(fileHashes(fixture.project), before);

    const escape = new ToolBroker({
      permissionProfile: "full",
      workspacePath: fixture.project,
      artifacts,
    });
    escape.register(uncontainedCommandDouble("double-wrote.txt"));
    const escaped = await escape.invoke(
      commandCall("verifier-escape", "ignored"),
      toolContext(fixture.workspace.path, "verifier"),
    );
    assert.equal(escaped.isError, false, JSON.stringify(escaped));
    assert.equal(existsSync(join(fixture.project, "double-wrote.txt")), true);
    rmSync(join(fixture.project, "double-wrote.txt"));
    assert.deepEqual(fileHashes(fixture.project), before);

    await fixture.manager.cleanup();
    assert.equal(existsSync(fixture.workspace.path), false);
  } finally {
    evidence.close();
    await fixture.manager.cleanup().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("architect and verifier commands require approval unless the profile is full", async () => {
  const root = mkdtempSync(join(tmpdir(), "a3-approval-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    for (const profile of ["guarded", "project", "full"] as const) {
      for (const role of ["architect", "verifier"] as const) {
        const project = join(root, `${role}-${profile}-project`);
        const copy = join(root, `${role}-${profile}-copy`);
        mkdirSync(project);
        mkdirSync(copy);
        writeFileSync(join(project, "keep.txt"), "project\n");
        const approvals: string[] = [];
        const permissions = {
          requestTool: async (request: { toolName: string }) => {
            approvals.push(request.toolName);
            return true;
          },
        } as unknown as SqlitePermissionStore;
        const runtime = role === "architect"
          ? composeArchitectInspection(
              createArchitectInspectionBroker({
                ...architectInput(project, artifacts),
                evidenceStore: evidence,
                permissionProfile: profile,
                permissions,
              }),
              createArchitectCommandBroker({
                disposablePath: copy,
                projectRoot: project,
                permissionProfile: profile,
                artifacts,
                evidenceStore: evidence,
                clock: () => "2026-09-23T00:00:00.000Z",
                permissions,
                commandTool: uncontainedCommandDouble("approved.txt"),
              }),
            )
          : createVerifierReviewBroker({
              ...inspectionInput(copy, artifacts),
              evidenceStore: evidence,
              projectRoot: project,
              permissionProfile: profile,
              permissions,
              commandTool: uncontainedCommandDouble("approved.txt"),
            });
        const before = fileHashes(project);
        const result = await runtime.invoke(
          commandCall(`${role}-${profile}`, "unused"),
          toolContext(project, role),
        );
        assert.equal(result.isError, false, `${role} ${profile} ${JSON.stringify(result)}`);
        assert.deepEqual(approvals, profile === "full" ? [] : ["run_evidence_command"]);
        assert.equal(existsSync(join(copy, "approved.txt")), true);
        assert.deepEqual(fileHashes(project), before);
      }
    }
  } finally {
    evidence.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function names(runtime: { definitions(): readonly { name: string }[] }): string[] {
  return runtime.definitions().map((definition) => definition.name).sort((left, right) => left.localeCompare(right));
}

function fileHashes(root: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        rows.push([
          relative(root, path).replaceAll("\\", "/"),
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]);
      }
    }
  };
  walk(root);
  return rows;
}

function commandCall(callId: string, script: string): ToolCallBlock {
  return {
    type: "tool_call",
    callId,
    name: "run_evidence_command",
    arguments: {
      label: callId,
      command: process.execPath,
      args: ["-e", script],
      cwd: ".",
    },
  };
}

function toolContext(workspacePath: string, role: "architect" | "verifier"): ToolExecutionContext {
  return {
    runId: "run",
    sessionId: `${role}:run`,
    actor: { role, id: role },
    workspacePath,
  };
}

function uncontainedCommandDouble(fileName: string): NativeTool<unknown> {
  return {
    definition: {
      name: "run_evidence_command",
      description: "Containment is a no-op. The broker workspace is the execution root.",
      inputSchema: { type: "object", additionalProperties: true },
      readOnly: false,
      effect: "external",
    },
    validate: (input) => ({ ok: true, value: input }),
    assessAccess: () => ({ capability: "evidence.command", external: true }),
    execute: async (_input, context) => {
      const root = context.workspacePath;
      if (!root) throw new Error("Command double requires the broker workspace.");
      writeFileSync(join(root, fileName), "ran\n");
      return { content: [{ type: "text", text: root }], isError: false };
    },
  };
}

async function readerCopyFixture(name: string): Promise<{
  root: string;
  project: string;
  state: string;
  manager: VerificationWorkspaceManager;
  workspace: { path: string };
}> {
  const root = mkdtempSync(join(tmpdir(), `a3-${name}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "README.md"), "project\n");
  const baseline = await captureGitBaseline({
    projectPath: project,
    stateDirectory: state,
    runId: name,
  });
  const manager = new VerificationWorkspaceManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId: name,
    kind: "independent-verifier",
    workspaceSuffix: name,
  });
  const workspace = await manager.create(baseline.revision);
  writeFileSync(join(project, "only-in-project.txt"), "only-in-project\n");
  return { root, project, state, manager, workspace };
}

function probeTool(
  name: string,
  overrides: { readonly readOnly?: boolean; readonly effect?: "none" | "workspace" | "external" } = {},
): NativeTool<unknown> {
  return {
    definition: {
      name,
      description: "Unlisted registration probe",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: overrides.readOnly ?? true,
      effect: overrides.effect ?? "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [], isError: false }),
  };
}

function classShapeMcpManager(): McpManager {
  const entry = (
    name: string,
    annotations: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean },
  ) => ({
    client: {
      spec: { name: "docs", command: "unused" },
      call: async () => ({ structuredContent: { ok: true } }),
      access: () => ({ capability: `mcp.docs.${name}`, external: true }),
    },
    tool: { name, annotations },
  });
  return {
    toolEntries: () => [
      entry("hint_only", { readOnlyHint: true }),
      entry("read_only", { readOnlyHint: true, destructiveHint: false }),
      entry("destructive", { readOnlyHint: true, destructiveHint: true }),
    ],
    closeAgent: async () => undefined,
  } as unknown as McpManager;
}

function attachUnusedManager<T extends object>(input: T, mcpManager: McpManager): T {
  return { ...input, mcpManager } as T;
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
  mcpManager?: McpManager,
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
    ...(mcpManager ? { mcpManager } : {}),
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
