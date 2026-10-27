import { EXTENSION_LIMITS, ExtensionManagementError, type SkillComponent } from "./extension-management-contracts.js";
import { buildTree, subtree, type PackageTree } from "./extension-package-store.js";

/**
 * Agent Skills (agentskills.io) structure checks for new managed installs. Frontmatter is parsed by a
 * deliberately tiny YAML subset: no tags, anchors, aliases, merge keys or multiple documents, so
 * metadata can never execute or expand. Nothing in a skill's metadata grants permissions.
 */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowedTools?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface DiscoveredSkill {
  readonly component: SkillComponent;
  readonly tree: PackageTree;
}

const MAX_FRONTMATTER_BYTES = 16 * 1024;
const KNOWN_KEYS = new Set(["name", "description", "license", "compatibility", "allowed-tools", "metadata"]);

type YamlValue = string | readonly string[] | Readonly<Record<string, string>>;

/** Parses the restricted frontmatter subset; throws ExtensionManagementError on anything outside it. */
export function parseSkillFrontmatter(content: string): { values: Map<string, YamlValue>; body: string } {
  const text = content.startsWith("﻿") ? content.slice(1) : content;
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) throw new ExtensionManagementError("skill_frontmatter_missing", "SKILL.md must start with YAML frontmatter (--- … ---) declaring name and description.");
  if (Buffer.byteLength(match[1]) > MAX_FRONTMATTER_BYTES) throw new ExtensionManagementError("skill_frontmatter_too_large", "Skill frontmatter is too large.");
  const lines = match[1].split(/\r?\n/);
  const values = new Map<string, YamlValue>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^(---|\.\.\.)\s*$/.test(line)) throw new ExtensionManagementError("skill_yaml_unsupported", "Multiple YAML documents are not allowed.");
    const entry = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*?))?[ \t]*$/);
    if (!entry) throw new ExtensionManagementError("skill_yaml_invalid", `Unsupported frontmatter line ${index + 1}.`);
    const key = entry[1];
    if (key === "<<") throw new ExtensionManagementError("skill_yaml_unsupported", "YAML merge keys are not allowed.");
    if (values.has(key)) throw new ExtensionManagementError("skill_yaml_invalid", `Duplicate frontmatter key ${key}.`);
    const raw = entry[2] ?? "";
    if (raw === "" ) {
      // Block: either a list ("- item") or a one-level string map ("  key: value").
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || /^-\s/.test(lines[index + 1]))) block.push(lines[++index]);
      if (block.length === 0) { values.set(key, ""); continue; }
      if (block.every((item) => /^\s*-\s+/.test(item))) {
        values.set(key, Object.freeze(block.map((item) => scalar(item.replace(/^\s*-\s+/, ""), key))));
      } else {
        const map: Record<string, string> = {};
        for (const item of block) {
          const pair = item.match(/^\s+([A-Za-z0-9_.-]+):[ \t]*(.*?)[ \t]*$/);
          if (!pair) throw new ExtensionManagementError("skill_yaml_unsupported", `Only one-level string maps are allowed under ${key}.`);
          if (Object.hasOwn(map, pair[1])) throw new ExtensionManagementError("skill_yaml_invalid", `Duplicate key ${key}.${pair[1]}.`);
          map[pair[1]] = scalar(pair[2], `${key}.${pair[1]}`);
        }
        values.set(key, Object.freeze(map));
      }
      continue;
    }
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || /^\s*$/.test(lines[index + 1]))) block.push(lines[++index]);
      const indent = Math.min(...block.filter((item) => item.trim()).map((item) => item.match(/^\s*/)![0].length));
      const stripped = block.map((item) => item.slice(Number.isFinite(indent) ? indent : 0));
      values.set(key, (raw.startsWith("|") ? stripped.join("\n") : stripped.join(" ").replace(/\s+/g, " ")).trim());
      continue;
    }
    if (raw.startsWith("[")) {
      if (!raw.endsWith("]")) throw new ExtensionManagementError("skill_yaml_unsupported", `Flow list for ${key} must be on one line.`);
      const inner = raw.slice(1, -1).trim();
      values.set(key, Object.freeze(inner ? inner.split(",").map((item) => scalar(item.trim(), key)) : []));
      continue;
    }
    if (raw.startsWith("{")) throw new ExtensionManagementError("skill_yaml_unsupported", `Flow maps are not allowed (${key}).`);
    values.set(key, scalar(raw, key));
  }
  return { values, body: text.slice(match[0].length) };
}

function scalar(raw: string, key: string): string {
  if (/^[!&*]/.test(raw)) throw new ExtensionManagementError("skill_yaml_unsupported", `YAML tags, anchors and aliases are not allowed (${key}).`);
  if (raw.startsWith("\"")) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) throw new ExtensionManagementError("skill_yaml_invalid", `Unterminated string for ${key}.`);
    try { return JSON.parse(raw) as string; } catch { throw new ExtensionManagementError("skill_yaml_invalid", `Invalid escaped string for ${key}.`); }
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) throw new ExtensionManagementError("skill_yaml_invalid", `Unterminated string for ${key}.`);
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  // Plain scalar: drop a trailing comment.
  return raw.replace(/\s+#.*$/, "");
}

/** Validates metadata against the Agent Skills format. Returns errors (blocking) and warnings. */
export function validateSkillFrontmatter(values: Map<string, YamlValue>, directoryName: string | undefined): { frontmatter?: SkillFrontmatter; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (key: string): string | undefined => {
    const value = values.get(key);
    if (value === undefined) return undefined;
    if (typeof value !== "string") { errors.push(`${key} must be a string.`); return undefined; }
    return value;
  };
  const name = text("name");
  const description = text("description");
  if (!name) errors.push("name is required.");
  else if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) errors.push("name must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen.");
  if (!description) errors.push("description is required.");
  else if (description.length > 1024) errors.push("description must be at most 1024 characters.");
  const compatibility = text("compatibility");
  if (compatibility !== undefined && compatibility.length > 500) errors.push("compatibility must be at most 500 characters.");
  const license = text("license");
  let allowedTools: string[] | undefined;
  const allowed = values.get("allowed-tools");
  if (typeof allowed === "string") allowedTools = allowed.split(/\s+/).filter(Boolean);
  else if (Array.isArray(allowed)) allowedTools = [...allowed];
  else if (allowed !== undefined) errors.push("allowed-tools must be a space-separated string or list.");
  if (allowedTools) warnings.push("allowed-tools is advisory: it never grants AI Board permissions.");
  const metadata = values.get("metadata");
  if (metadata !== undefined && (typeof metadata !== "object" || Array.isArray(metadata))) errors.push("metadata must be a map of strings.");
  for (const key of values.keys()) if (!KNOWN_KEYS.has(key)) warnings.push(`Unknown frontmatter field ${key} is ignored.`);
  if (name && directoryName && directoryName !== name) warnings.push(`Skill folder "${directoryName}" differs from its name "${name}"; it is installed as "${name}".`);
  if (errors.length || !name || !description) return { errors, warnings };
  return {
    frontmatter: Object.freeze({
      name, description,
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      ...(allowedTools ? { allowedTools: Object.freeze(allowedTools) } : {}),
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { metadata: metadata as Readonly<Record<string, string>> } : {}),
    }),
    errors, warnings,
  };
}

/**
 * Finds every skill (a folder holding SKILL.md) in a package. A skill folder's own subfolders belong
 * to it (scripts/, references/, assets/); nested SKILL.md files inside a skill are not separate skills.
 */
export function discoverSkills(tree: PackageTree): { skills: DiscoveredSkill[]; invalid: { path: string; errors: string[] }[] } {
  const skillDirectories = tree.files
    .filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => file.path === "SKILL.md" ? "" : file.path.slice(0, -"/SKILL.md".length))
    .filter((directory) => !directory.split("/").some((part) => part.startsWith(".")))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  const roots: string[] = [];
  for (const directory of skillDirectories) {
    if (!roots.some((root) => root === "" || directory.startsWith(`${root}/`))) roots.push(directory);
  }
  const skills: DiscoveredSkill[] = [];
  const invalid: { path: string; errors: string[] }[] = [];
  for (const directory of roots) {
    const skillTree = subtree(tree, directory);
    const skillFile = skillTree.files.find((file) => file.path === "SKILL.md")!;
    if (skillFile.bytes.byteLength > EXTENSION_LIMITS.maxSkillResourceBytes) {
      invalid.push({ path: directory || ".", errors: [`SKILL.md exceeds ${EXTENSION_LIMITS.maxSkillResourceBytes} bytes.`] });
      continue;
    }
    let parsed: ReturnType<typeof parseSkillFrontmatter>;
    try {
      parsed = parseSkillFrontmatter(skillFile.bytes.toString("utf8"));
    } catch (error) {
      invalid.push({ path: directory || ".", errors: [error instanceof Error ? error.message : String(error)] });
      continue;
    }
    const directoryName = directory ? directory.split("/").at(-1) : undefined;
    const checked = validateSkillFrontmatter(parsed.values, directoryName);
    if (!checked.frontmatter) {
      invalid.push({ path: directory || ".", errors: checked.errors });
      continue;
    }
    const missing = missingReferencedResources(parsed.body, new Set(skillTree.files.map((file) => file.path)));
    const warnings = [...checked.warnings, ...missing.map((path) => `SKILL.md references ${path}, which is not in the package.`)];
    const scripts = skillTree.files.filter((file) => file.path.startsWith("scripts/")).length;
    if (scripts) warnings.push(`${scripts} script file(s) are included; installing never runs them.`);
    skills.push({
      tree: skillTree,
      component: Object.freeze({
        kind: "skill",
        componentId: `skill:${checked.frontmatter.name}`,
        skillName: checked.frontmatter.name,
        description: checked.frontmatter.description,
        packagePath: directory,
        digest: skillTree.digest,
        files: skillTree.files.length,
        ...(checked.frontmatter.allowedTools ? { allowedTools: checked.frontmatter.allowedTools } : {}),
        ...(checked.frontmatter.license ? { license: checked.frontmatter.license } : {}),
        ...(checked.frontmatter.compatibility ? { compatibility: checked.frontmatter.compatibility } : {}),
        warnings: Object.freeze(warnings),
      }),
    });
  }
  return { skills, invalid };
}

/** A single uploaded SKILL.md becomes a one-file skill folder named by its own metadata. */
export function singleFileSkillTree(content: Buffer): PackageTree {
  return buildTree([{ path: "SKILL.md", bytes: content, executable: false }]);
}

/** Relative links and conventional resource paths mentioned by the instructions. */
export function missingReferencedResources(body: string, present: ReadonlySet<string>): string[] {
  const referenced = new Set<string>();
  for (const match of body.matchAll(/\]\(([^)\s#?]+)(?:[#?][^)]*)?\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/") || target.startsWith("#")) continue;
    referenced.add(target.replace(/^\.\//, ""));
  }
  for (const match of body.matchAll(/(?:^|[\s`'"(])((?:scripts|references|assets)\/[A-Za-z0-9_./-]+[A-Za-z0-9_-])/g)) referenced.add(match[1]);
  return [...referenced]
    .filter((path) => !path.split("/").includes(".."))
    .filter((path) => !present.has(path) && ![...present].some((file) => file.startsWith(`${path.replace(/\/$/, "")}/`)))
    .sort();
}
