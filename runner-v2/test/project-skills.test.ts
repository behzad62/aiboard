import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverProjectInstructions } from "../src/project-context.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { createSkillTools } from "../src/skill-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("project instructions are ordered by scope and cannot escape the repository", async () => {
  const fixture = projectFixture();
  try {
    mkdirSync(join(fixture.project, "src", "feature"), { recursive: true });
    writeFileSync(join(fixture.project, "AGENTS.md"), "root agents\n");
    writeFileSync(join(fixture.project, "CLAUDE.md"), "root claude\n");
    writeFileSync(join(fixture.project, "src", "AGENTS.md"), "src agents\n");
    const sources = await discoverProjectInstructions({
      projectRoot: fixture.project,
      targetPath: join(fixture.project, "src", "feature"),
    });
    assert.deepEqual(
      sources.map((source) => source.relativePath.replaceAll("\\", "/")),
      ["AGENTS.md", "CLAUDE.md", "src/AGENTS.md"]
    );
    assert.equal(sources.every((source) => /^[a-f0-9]{64}$/.test(source.digest)), true);
    assert.equal(sources.at(-1)?.scopeDirectory.replaceAll("\\", "/"), "src");
    await assert.rejects(
      () => discoverProjectInstructions({
        projectRoot: fixture.project,
        targetPath: fixture.outside,
      }),
      /outside project/i
    );
  } finally {
    fixture.cleanup();
  }
});

test("skill catalog discovers project-local skills with provenance and blocks symlink escape", async () => {
  const fixture = projectFixture();
  try {
    const skillDir = join(fixture.project, ".agents", "skills", "testing");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: testing\ndescription: Run focused tests safely\n---\n# Testing\nUse the smallest relevant test first.\n"
    );
    const outsideSkill = join(fixture.outside, "escape");
    mkdirSync(outsideSkill, { recursive: true });
    writeFileSync(join(outsideSkill, "SKILL.md"), "# Escape\nDo not load me.\n");
    const link = join(fixture.project, ".agents", "skills", "escape");
    symlinkSync(outsideSkill, link, "junction");

    const oversized = join(fixture.project, ".agents", "skills", "oversized");
    mkdirSync(oversized, { recursive: true });
    writeFileSync(join(oversized, "SKILL.md"), `# Oversized\n${"x".repeat(300)}`);

    const catalog = new SkillCatalog({ projectRoot: fixture.project, maxSkillBytes: 256 });
    const skills = await catalog.discover();
    assert.deepEqual(skills.map((skill) => skill.id), [".agents/skills/testing"]);
    assert.equal(skills[0].name, "testing");
    assert.equal(skills[0].description, "Run focused tests safely");
    assert.match((await catalog.read(skills[0].id)).content, /smallest relevant test/);
    await assert.rejects(() => catalog.read(".agents/skills/escape"), /unknown skill/i);
  } finally {
    fixture.cleanup();
  }
});

test("skill tools list and read bounded project skills without lifecycle authority", async () => {
  const fixture = projectFixture();
  try {
    const skillDir = join(fixture.project, ".aiboard", "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Review\nInspect the diff.\n");
    const catalog = new SkillCatalog({
      projectRoot: fixture.project,
      maxSkillBytes: 64,
    });
    const registry = new ToolRegistry();
    for (const tool of createSkillTools(catalog)) registry.register(tool);
    const context = {
      runId: "run_1",
      sessionId: "worker_1",
      actor: { role: "worker" as const, id: "worker_1" },
    };
    const listed = await registry.invoke(
      { type: "tool_call", callId: "list", name: "list_skills", arguments: {} },
      context
    );
    assert.equal(listed.isError, false);
    assert.equal(listed.lifecycle, undefined);
    const read = await registry.invoke(
      {
        type: "tool_call",
        callId: "read",
        name: "read_skill",
        arguments: { id: ".aiboard/skills/review" },
      },
      context
    );
    assert.equal(read.isError, false);
    assert.equal(read.lifecycle, undefined);
    assert.match(read.content[0].type === "text" ? read.content[0].text : "", /Inspect/);
  } finally {
    fixture.cleanup();
  }
});

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-project-skills-"));
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return {
    project,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
