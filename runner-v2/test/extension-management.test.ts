import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { ExtensionManagementService, type ManagementCaller } from "../src/extension-management-service.js";
import { ExtensionManagementError } from "../src/extension-management-contracts.js";
import { readZipArchive, snapshotDirectory } from "../src/extension-package-store.js";
import { discoverSkills, parseSkillFrontmatter } from "../src/extension-skill-validation.js";
import { extractSourcesFromText, sourceKey } from "../src/extension-sources.js";
import { createBoundedGitCommandExecutor } from "../src/git-preflight.js";

const STORAGE_KEY = Buffer.alloc(32, 1);
const UI: ManagementCaller = { kind: "ui" };

function skill(name: string, description = `Use ${name} for tests.`, body = "Follow the steps.\n"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${body}`;
}

function agent(conversationId: string, overrides: Partial<Extract<ManagementCaller, { kind: "agent" }>> = {}): ManagementCaller {
  return { kind: "agent", runId: "run-1", sessionId: "session-1", actorRole: "chat", actorId: "chat-agent", conversationId, canMutate: true, ...overrides };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiboard-ext-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const sources = join(root, "sources");
  await mkdir(project, { recursive: true });
  await mkdir(sources, { recursive: true });
  const credentials = new ExtensionCredentialStore(join(root, "state", "extension-credentials.enc"), STORAGE_KEY);
  const open = (extra: Partial<Parameters<typeof ExtensionManagementService.open>[0]> = {}) => ExtensionManagementService.open({
    home, projectRoot: project, credentials,
    git: { executorFor: (cwd) => createBoundedGitCommandExecutor({ executionDeadlineMs: 30_000, terminationDeadlineMs: 5_000, environment: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, cwd }) },
    ...extra,
  });
  return { root, project, home, sources, credentials, service: await open(), open, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writeSkill(directory: string, name: string, extra: Record<string, string> = {}, body?: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), skill(name, undefined, body));
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), content);
  }
}

/** Minimal ZIP writer for fixtures (deflate entries, optional unix modes). */
function zip(entries: { name: string; data: Buffer | string; mode?: number; store?: boolean; flags?: number; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const compressed = entry.store ? data : deflateRawSync(data);
    const name = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE((entry.flags ?? 0) | 0x800, 6); local.writeUInt16LE(entry.store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.declaredSize ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE((entry.flags ?? 0) | 0x800, 8); central.writeUInt16LE(entry.store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.declaredSize ?? data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function code(error: unknown): string | undefined {
  return error instanceof ExtensionManagementError ? error.code : undefined;
}

test("ZIP reader strips one top folder and refuses traversal, links, bombs, collisions and encryption", () => {
  const ok = readZipArchive(zip([{ name: "repo-main/skills/a/SKILL.md", data: skill("a") }, { name: "repo-main/skills/a/scripts/run.sh", data: "echo hi", mode: 0o100755 }]));
  assert.deepEqual(ok.files.map((file) => file.path), ["skills/a/SKILL.md", "skills/a/scripts/run.sh"]);
  assert.equal(ok.files[1].executable, true);
  assert.throws(() => readZipArchive(zip([{ name: "../evil/SKILL.md", data: "x" }])), (error) => code(error) === "package_path_traversal");
  assert.throws(() => readZipArchive(zip([{ name: "C:/evil.txt", data: "x" }])), (error) => code(error) === "package_path_traversal");
  assert.throws(() => readZipArchive(zip([{ name: "link", data: "/etc/passwd", mode: 0o120777, store: true }])), (error) => code(error) === "package_link_refused");
  assert.throws(() => readZipArchive(zip([{ name: "bomb.txt", data: Buffer.alloc(2 * 1024 * 1024) }])), (error) => code(error) === "archive_bomb");
  // A lying declared size cannot expand beyond it: inflate is capped at the declared length.
  assert.throws(() => readZipArchive(zip([{ name: "liar.txt", data: Buffer.alloc(64 * 1024, 1), declaredSize: 1024 }])), (error) => ["archive_bomb", "archive_corrupt"].includes(code(error) ?? ""));
  assert.throws(() => readZipArchive(zip([{ name: "a/SKILL.md", data: "x" }, { name: "A/skill.md", data: "y" }])), (error) => code(error) === "package_path_collision");
  assert.throws(() => readZipArchive(zip([{ name: "x.txt", data: "x", flags: 1 }])), (error) => code(error) === "archive_unsupported");
  assert.throws(() => readZipArchive(Buffer.from("not a zip")), (error) => code(error) === "archive_corrupt");
});

test("skill frontmatter is a safe YAML subset validated against the Agent Skills format", () => {
  assert.throws(() => parseSkillFrontmatter("---\nname: !!python/object x\ndescription: d\n---\n"), (error) => code(error) === "skill_yaml_unsupported");
  assert.throws(() => parseSkillFrontmatter("---\nname: &a x\ndescription: *a\n---\n"), (error) => code(error) === "skill_yaml_unsupported");
  assert.throws(() => parseSkillFrontmatter("# no frontmatter"), (error) => code(error) === "skill_frontmatter_missing");
  const parsed = parseSkillFrontmatter("---\nname: pdf-tools\ndescription: >\n  Fill PDF forms\n  and extract text.\nallowed-tools: Bash Read\nmetadata:\n  author: acme\n---\nBody");
  assert.equal(parsed.values.get("description"), "Fill PDF forms and extract text.");
  assert.deepEqual(parsed.values.get("metadata"), { author: "acme" });
  const tree = { files: [{ path: "Bad_Name/SKILL.md", bytes: Buffer.from(skill("Bad_Name")), executable: false }], digest: "x", totalBytes: 1 };
  const found = discoverSkills(tree as never);
  assert.equal(found.skills.length, 0);
  assert.match(found.invalid[0].errors.join(" "), /lowercase/);
});

test("a folder source is snapshotted without links, preserving resources and reporting missing references", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const source = join(env.sources, "lint-helper");
  await writeSkill(source, "lint-helper", { "scripts/check.sh": "echo check", "references/rules.md": "# Rules" }, "Run scripts/check.sh and read [rules](references/rules.md) and assets/logo.png.\n");
  const inspection = await env.service.inspectSource({ type: "local_directory", path: source }, UI);
  assert.equal(inspection.kind, "skill");
  assert.equal(inspection.components.length, 1);
  const component = inspection.components[0];
  assert.equal(component.kind, "skill");
  assert.ok(component.kind === "skill" && component.warnings.some((warning) => warning.includes("assets/logo.png")));
  assert.ok(component.kind === "skill" && component.warnings.some((warning) => /script file\(s\) are included; installing never runs them/.test(warning)));
  try {
    await symlink(join(env.root, "project"), join(source, "escape"), "junction");
  } catch {
    t.diagnostic("symlink creation unavailable; link refusal covered by the ZIP test");
    return;
  }
  await assert.rejects(snapshotDirectory(source), (error) => code(error) === "package_link_refused");
});

test("Settings installs a local skill into the content-addressed store; discovery reads it; the source is untouched", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const source = join(env.sources, "release-notes");
  await writeSkill(source, "release-notes", { "references/template.md": "## Template" });
  const inspection = await env.service.inspectSource({ type: "local_directory", path: source }, UI);
  const plan = await env.service.planChange({ action: "install", inspectionId: inspection.inspectionId, scope: env.service.projectScope() }, UI);
  assert.equal(plan.action, "install");
  assert.equal(plan.requiresExecutableTrust, false);
  const operation = await env.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "ui-install-release-notes" }, UI);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("\n"));
  assert.equal(operation.authorizationOrigin, "ui");
  assert.deepEqual(operation.progress.map((entry) => entry.stage).filter((stage, index, all) => all.indexOf(stage) === index), ["resolve", "inspect", "stage", "validate", "commit", "activate", "ready"]);
  const inventory = await env.service.inventory();
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0].readiness.state, "ready");
  assert.equal(inventory.items[0].scope.kind, "project");
  assert.equal(inventory.currentGeneration, 1);
  const skills = await env.service.managedSkills(1);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "release-notes");
  assert.match(skills[0].directory, /packages[\\/][a-f0-9]{64}$/);
  assert.equal(await readFile(join(skills[0].directory, "references", "template.md"), "utf8"), "## Template");
  // Same key + same plan replays the stored outcome; a changed request under the key conflicts.
  const replay = await env.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "ui-install-release-notes" }, UI);
  assert.equal(replay.id, operation.id);
  await assert.rejects(env.service.applyChange({ planId: plan.planId, planDigest: "0".repeat(64), key: "ui-install-release-notes" }, UI), (error) => code(error) === "operation_key_conflict");
  // Removal deletes only store-owned copies, never the user's folder.
  const removal = await env.service.planChange({ action: "remove", extensionId: inventory.items[0].id }, UI);
  const removed = await env.service.applyChange({ planId: removal.planId, planDigest: removal.planDigest, key: "ui-remove-release-notes" }, UI);
  assert.equal(removed.outcome, "succeeded");
  assert.equal((await readdir(source)).sort().join(","), "SKILL.md,references");
  assert.equal((await env.service.inventory()).items.length, 0);
  assert.equal((await env.service.managedSkills(removed.result!.generation!)).length, 0);
  // Generation 1 is immutable and still names the removed version for any run pinned to it.
  assert.equal((await env.service.generation(1)).entries.length, 1);
});

test("an agent installs a source the human named without asking again; an unnamed source needs one approval card", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const named = join(env.sources, "changelog");
  const unnamed = join(env.sources, "sneaky");
  await writeSkill(named, "changelog");
  await writeSkill(unnamed, "sneaky");
  env.service.authorizer.recordHumanMessage("conv-1", `Please install the skill at ${named} for this project.`);
  const caller = agent("conv-1");
  const inspection = await env.service.inspectSource({ type: "local_directory", path: named }, caller);
  const plan = await env.service.planChange({ action: "install", inspectionId: inspection.inspectionId }, caller);
  const operation = await env.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "agent-op-changelog" }, caller);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("\n"));
  assert.equal(operation.authorizationOrigin, "human_message");
  assert.equal(operation.owner.kind, "agent");

  // The agent cannot even inspect a folder outside the project that the human never named.
  await assert.rejects(env.service.inspectSource({ type: "local_directory", path: unnamed }, caller), (error) => code(error) === "source_not_permitted");
  // Text the model read elsewhere (a README) is not human intent: only recordHumanMessage creates intent,
  // and it is called by authenticated message routes, never with tool output. A different conversation has none.
  const other = agent("conv-2");
  const inProject = join(env.project, "vendor-skill");
  await writeSkill(inProject, "vendor-skill");
  const second = await env.service.inspectSource({ type: "local_directory", path: inProject }, other);
  const secondPlan = await env.service.planChange({ action: "install", inspectionId: second.inspectionId }, other);
  const pending = await env.service.applyChange({ planId: secondPlan.planId, planDigest: secondPlan.planDigest, key: "agent-op-vendor" }, other);
  assert.equal(pending.outcome, "awaiting_user");
  assert.equal(pending.userAction?.kind, "approve");
  await assert.rejects(env.service.approve(pending.id, secondPlan.planDigest, other), (error) => code(error) === "ui_only");
  await assert.rejects(env.service.approve(pending.id, "f".repeat(64), UI), (error) => code(error) === "plan_changed");
  const approved = await env.service.approve(pending.id, secondPlan.planDigest, UI);
  assert.equal(approved.outcome, "succeeded");
  assert.equal(approved.authorizationOrigin, "ui");
});

test("workers can read but cannot change installed capabilities", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const source = join(env.project, "skills", "fmt");
  await writeSkill(source, "fmt");
  const worker = agent("conv-w", { actorRole: "worker", canMutate: false });
  const inspection = await env.service.inspectSource({ type: "local_directory", path: source }, worker);
  await assert.rejects(env.service.planChange({ action: "install", inspectionId: inspection.inspectionId }, worker), (error) => code(error) === "role_cannot_manage");
});

test("disable, enable and rollback publish new generations without rewriting old ones", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const source = join(env.sources, "notes");
  await writeSkill(source, "notes", {}, "Version one.\n");
  const install = async (key: string) => {
    const inspection = await env.service.inspectSource({ type: "local_directory", path: source }, UI);
    const plan = await env.service.planChange({ action: "install", inspectionId: inspection.inspectionId }, UI);
    return await env.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key }, UI);
  };
  const first = await install("install-notes-v1");
  assert.equal(first.outcome, "succeeded");
  await writeFile(join(source, "SKILL.md"), skill("notes", undefined, "Version two.\n"));
  const second = await install("install-notes-v2");
  assert.equal(second.action, "update");
  assert.equal(second.outcome, "succeeded");
  const id = second.result!.extensionId!;
  const v2 = await env.service.managedSkills(second.result!.generation!);
  assert.match(await readFile(join(v2[0].directory, "SKILL.md"), "utf8"), /Version two/);
  const applyLifecycle = async (action: "disable" | "enable" | "rollback", key: string) => {
    const plan = await env.service.planChange({ action, extensionId: id }, UI);
    return await env.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key }, UI);
  };
  const disabled = await applyLifecycle("disable", "disable-notes-1");
  assert.equal((await env.service.managedSkills(disabled.result!.generation!)).length, 0);
  const enabled = await applyLifecycle("enable", "enable-notes-1");
  assert.equal((await env.service.managedSkills(enabled.result!.generation!)).length, 1);
  const rolled = await applyLifecycle("rollback", "rollback-notes-1");
  assert.equal(rolled.outcome, "succeeded");
  const restored = await env.service.managedSkills(rolled.result!.generation!);
  assert.match(await readFile(join(restored[0].directory, "SKILL.md"), "utf8"), /Version one/);
  // Earlier generations still resolve to the bytes they named.
  assert.match(await readFile(join((await env.service.managedSkills(second.result!.generation!))[0].directory, "SKILL.md"), "utf8"), /Version two/);
});

test("pinned Git sources resolve one exact commit and a selected subfolder without running repository code", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const repo = join(env.sources, "skills-repo");
  await writeSkill(join(repo, "skills", "alpha"), "alpha", { "scripts/setup.sh": "touch PWNED" });
  await writeSkill(join(repo, "skills", "beta"), "beta");
  await mkdir(join(repo, ".githooks"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "skills");
  const commit = git("rev-parse", "HEAD");
  const whole = await env.service.inspectSource({ type: "git", url: repo }, UI);
  assert.equal(whole.source.type === "git" && whole.source.commit, commit);
  assert.deepEqual(whole.components.map((component) => component.kind === "skill" && component.skillName).sort(), ["alpha", "beta"]);
  await assert.rejects(env.service.planChange({ action: "install", inspectionId: whole.inspectionId }, UI), (error) => code(error) === "selection_required");
  const plan = await env.service.planChange({ action: "install", inspectionId: whole.inspectionId, componentIds: ["alpha"] }, UI);
  const operation = await env.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "git-install-alpha" }, UI);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("\n"));
  const [installed] = await env.service.managedSkills(operation.result!.generation!);
  assert.equal(await readFile(join(installed.directory, "scripts", "setup.sh"), "utf8"), "touch PWNED");
  await assert.rejects(readFile(join(installed.directory, "PWNED")));
  // Agents may not use local or non-https Git sources.
  env.service.authorizer.recordHumanMessage("conv-git", `install from ${repo}`);
  await assert.rejects(env.service.inspectSource({ type: "git", url: repo }, agent("conv-git")), (error) => code(error) === "invalid_source");
});

test("restart recovery: interrupted executable work is outcome_unknown, pre-commit work is a safe failure", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const now = new Date().toISOString();
  const base = { owner: { kind: "ui" as const }, action: "install" as const, target: { name: "x" }, scope: { kind: "user" as const }, requestFingerprint: "f", progress: [], diagnostics: [], createdAt: now, updatedAt: now };
  await env.service.registry.mutate((state) => {
    state.putOperation({ ...base, id: "op_install", key: "recover-install-key", stage: "install_dependencies", outcome: "running" });
    state.putOperation({ ...base, id: "op_stage", key: "recover-stage-key", stage: "stage", outcome: "running" });
  });
  const reopened = await env.open();
  const operations = await reopened.listOperations();
  assert.equal(operations.find((entry) => entry.id === "op_install")?.outcome, "outcome_unknown");
  assert.equal(operations.find((entry) => entry.id === "op_stage")?.outcome, "failed");
});

test("human-message source extraction recognizes links, packages and paths, and keys match across forms", () => {
  const sources = extractSourcesFromText("Install https://github.com/acme/skills/tree/main/skills/pdf and npm @modelcontextprotocol/server-everything@2025.1.1 plus pip install mcp-server-fetch==1.2.0 and D:/work/skills/x.");
  const keys = sources.map((source) => sourceKey(source));
  assert.ok(keys.includes("git:https://github.com/acme/skills#skills/pdf"));
  assert.ok(keys.includes("npm:@modelcontextprotocol/server-everything"));
  assert.ok(keys.includes("pypi:mcp-server-fetch"));
  assert.ok(keys.some((key) => key.startsWith("local:") && key.endsWith("/work/skills/x")));
});

test("credentials are stored encrypted on the Runner and never written to registry or operation files", async (t) => {
  const env = await fixture();
  t.after(env.cleanup);
  const stored = env.credentials.put({ extensionId: "ext_abcdefgh", name: "API_TOKEN", kind: "env", value: "super-secret-value-123" });
  assert.match(stored.ref, /^cred_[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(env.credentials.list()).includes("super-secret"), false);
  const encrypted = await readFile(join(env.root, "state", "extension-credentials.enc"), "utf8");
  assert.equal(encrypted.includes("super-secret"), false);
  assert.equal(env.credentials.reveal(stored.ref).value, "super-secret-value-123");
  for (const file of ["registry.json", "operations.json"]) {
    const text = await readFile(join(env.home, file), "utf8").catch(() => "");
    assert.equal(text.includes("super-secret"), false);
  }
  await assert.rejects(env.service.submitCredential("ext_abcdefgh", "API_TOKEN", "x", agent("conv")), (error) => code(error) === "ui_only");
});
