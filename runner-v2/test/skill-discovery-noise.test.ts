import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillCatalog, type SkillMetadata } from "../src/skill-catalog.js";
import { rankSkillsForTask } from "../src/skill-routing.js";

function writeSkill(directory: string, name: string, description: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
}

// Tunnel run: deleted Claude.ai skills under ~/.claude/skills/.trash (and the app-managed
// `synced` copies) were injected into every Architect turn.
test("skill discovery skips hidden folders and a shared root's excluded folders", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-skill-noise-"));
  try {
    const project = join(root, "project");
    const shared = join(root, "claude-skills");
    mkdirSync(project);
    writeSkill(join(shared, "kept"), "kept", "A user skill");
    writeSkill(join(shared, ".trash", "123-abc", "computer-use"), "computer-use", "Deleted copy");
    writeSkill(join(shared, "synced", "account", "docs"), "docs", "App-managed copy");
    writeSkill(join(project, ".claude", "skills", ".staging", "pptx"), "pptx", "Staged copy");
    writeSkill(join(project, ".claude", "skills", "local"), "local", "A project skill");
    const catalog = new SkillCatalog({
      projectRoot: project,
      sharedRoots: [{ path: shared, source: "user", excludeDirectories: ["synced"] }],
    });
    const names = (await catalog.discover()).map((skill) => skill.name).sort();
    assert.deepEqual(names, ["kept", "local"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("function words alone never route an unrelated skill", () => {
  const skill = (name: string, description: string): SkillMetadata => ({
    id: `user:${name}`, name, description, relativePath: `${name}/SKILL.md`,
    digest: name.padEnd(64, "0").slice(0, 64), byteLength: 100, source: "user",
  });
  const selected = rankSkillsForTask(
    [skill("spreadsheets", "Use this when it is a file that may be opened, or if they ask about one of their own sheets")],
    "Build a relay so that it can forward requests; this must be fast and its errors are clear",
    ["planning"],
    3
  );
  assert.deepEqual(selected, []);
});
