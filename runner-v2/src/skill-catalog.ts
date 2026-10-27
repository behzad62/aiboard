import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ManagedSkillSource } from "./extension-management-service.js";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  digest: string;
  byteLength: number;
  source: "project" | "built-in" | "user" | "managed";
  /** Managed skills: installation scope, identity and the capability generation they were bound from. */
  scope?: "user" | "project";
  extensionId?: string;
  versionId?: string;
  packageDigest?: string;
  generation?: number;
  /** Set when another skill with the same name takes precedence (see skillSourcePrecedence). */
  shadowedBy?: string;
}

export interface SkillResource {
  skillId: string;
  path: string;
  byteLength: number;
  sha256: string;
  content: string;
}

export interface SkillDocument extends SkillMetadata {
  content: string;
}

export interface SkillCatalogOptions {
  projectRoot: string;
  maxSkills?: number;
  maxDepth?: number;
  maxSkillBytes?: number;
  roots?: readonly string[];
  sharedRoots?: readonly SharedSkillRoot[];
  /**
   * Installed skills from one pinned capability generation (immutable store directories). A function
   * is re-evaluated at each discovery, so a run's generation transition applies at its next call.
   */
  managed?: readonly ManagedSkillSource[] | (() => Promise<readonly ManagedSkillSource[]>);
}

export interface SharedSkillRoot {
  path: string;
  source: "built-in" | "user";
  /** Top-level folders under this root that hold another tool's managed skills, never AIBoard's. */
  excludeDirectories?: readonly string[];
}

/** Lower wins: a project's own files are never shadowed by an installed or user-wide skill. */
export function skillSourcePrecedence(skill: Pick<SkillMetadata, "source" | "scope">): number {
  if (skill.source === "project") return 0;
  if (skill.source === "managed") return skill.scope === "project" ? 1 : 2;
  return skill.source === "user" ? 3 : 4;
}

const MAX_SKILL_RESOURCE_BYTES = 256 * 1024;

const DEFAULT_ROOTS = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".aiboard/skills",
] as const;

export class SkillCatalog {
  private readonly projectRootInput: string;
  private readonly maxSkills: number;
  private readonly maxDepth: number;
  private readonly maxSkillBytes: number;
  private readonly roots: readonly string[];
  private readonly sharedRoots: readonly SharedSkillRoot[];
  private readonly managed: readonly ManagedSkillSource[] | (() => Promise<readonly ManagedSkillSource[]>);
  private cache: Map<string, SkillMetadata> | undefined;
  private skillPaths = new Map<string, string>();
  private canonicalRoot: string | undefined;

  constructor(options: SkillCatalogOptions) {
    this.projectRootInput = resolve(options.projectRoot);
    this.maxSkills = options.maxSkills ?? 200;
    this.maxDepth = options.maxDepth ?? 4;
    this.maxSkillBytes = options.maxSkillBytes ?? 256 * 1024;
    this.roots = options.roots ?? DEFAULT_ROOTS;
    this.sharedRoots = options.sharedRoots ?? [];
    this.managed = options.managed ?? [];
    assertPositive(this.maxSkills, "maxSkills");
    assertPositive(this.maxDepth, "maxDepth");
    assertPositive(this.maxSkillBytes, "maxSkillBytes");
  }

  async discover(): Promise<SkillMetadata[]> {
    const root = await this.root();
    const discovered = new Map<string, SkillMetadata>();
    const skillPaths = new Map<string, string>();
    for (const configured of this.roots) {
      if (isAbsolute(configured) || configured.split(/[\\/]+/).includes("..")) {
        throw new Error(`Skill root ${configured} must be project-relative.`);
      }
      const searchRoot = resolve(root, configured);
      if (!contained(root, searchRoot)) throw new Error(`Skill root ${configured} escapes project.`);
      await this.walk(searchRoot, root, root, "", "project", 0, discovered, skillPaths);
    }
    for (const shared of this.sharedRoots) {
      if (!isAbsolute(shared.path)) {
        throw new Error(`Shared skill root ${shared.path} must be absolute.`);
      }
      let canonicalShared: string;
      try {
        canonicalShared = await realpath(shared.path);
      } catch {
        continue;
      }
      await this.walk(
        canonicalShared,
        canonicalShared,
        canonicalShared,
        `${shared.source}:`,
        shared.source,
        0,
        discovered,
        skillPaths,
        shared.excludeDirectories
      );
    }
    const managedSkills = typeof this.managed === "function" ? await this.managed() : this.managed;
    for (const managed of managedSkills) {
      if (discovered.size >= this.maxSkills) break;
      const path = join(managed.directory, "SKILL.md");
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch {
        continue;
      }
      if (bytes.byteLength > this.maxSkillBytes) continue;
      const id = `managed:${managed.scope}:${managed.name}`;
      discovered.set(id, {
        id,
        name: managed.name,
        description: managed.description,
        relativePath: `${id}/SKILL.md`,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        source: "managed",
        scope: managed.scope,
        extensionId: managed.extensionId,
        versionId: managed.versionId,
        packageDigest: managed.packageDigest,
        generation: managed.generation,
      });
      skillPaths.set(id, path);
    }
    markShadowed(discovered);
    this.cache = discovered;
    this.skillPaths = skillPaths;
    return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Bounded read of a text resource bundled with a skill (references/, scripts/, assets/). The path is
   * confined to the skill's own folder, so installed skills outside the worktree remain usable.
   */
  async readResource(id: string, resourcePath: string): Promise<SkillResource> {
    const skills = this.cache ?? new Map((await this.discover()).map((skill) => [skill.id, skill]));
    const metadata = skills.get(normalize(id));
    if (!metadata) throw new Error(`Unknown skill ${id}.`);
    const skillFile = this.skillPaths.get(metadata.id);
    if (!skillFile) throw new Error(`Skill ${id} has no discovered source path.`);
    const relativePath = normalize(resourcePath).replace(/^\.\//, "");
    if (!relativePath || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error("Resource paths are relative to the skill folder and cannot leave it.");
    }
    const skillDirectory = await realpath(dirname(skillFile));
    const target = join(skillDirectory, ...relativePath.split("/"));
    const details = await lstat(target).catch(() => undefined);
    if (!details) throw new Error(`Skill ${id} has no resource ${relativePath}.`);
    if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${relativePath} is not a regular file in skill ${id}.`);
    const canonical = await realpath(target);
    if (!contained(skillDirectory, canonical)) throw new Error("Resource escapes the skill folder.");
    if (details.size > MAX_SKILL_RESOURCE_BYTES) throw new Error(`${relativePath} exceeds ${MAX_SKILL_RESOURCE_BYTES} bytes.`);
    const bytes = await readFile(canonical);
    const content = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error(`${relativePath} is binary; use image.inspect for images or run scripts through the normal command tools.`);
    }
    return { skillId: metadata.id, path: relativePath, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), content };
  }

  async read(id: string): Promise<SkillDocument> {
    const skills = this.cache ?? new Map((await this.discover()).map((skill) => [skill.id, skill]));
    const metadata = skills.get(normalize(id));
    if (!metadata) throw new Error(`Unknown skill ${id}.`);
    if (metadata.byteLength > this.maxSkillBytes) {
      throw new Error(`Skill ${id} exceeds maxSkillBytes.`);
    }
    const canonical = this.skillPaths.get(metadata.id);
    if (!canonical) throw new Error(`Skill ${id} has no discovered source path.`);
    const bytes = await readFile(canonical);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== metadata.digest) {
      this.cache = undefined;
      throw new Error(`Skill ${id} changed after discovery; rediscover before reading.`);
    }
    return { ...metadata, content: bytes.toString("utf8") };
  }

  private async walk(
    directory: string,
    containmentRoot: string,
    catalogRoot: string,
    idPrefix: string,
    source: SkillMetadata["source"],
    depth: number,
    discovered: Map<string, SkillMetadata>,
    skillPaths: Map<string, string>,
    excludeDirectories: readonly string[] = []
  ): Promise<void> {
    if (depth > this.maxDepth || discovered.size >= this.maxSkills) return;
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await realpath(directory);
    } catch {
      return;
    }
    if (!contained(containmentRoot, canonicalDirectory)) return;
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skillFile) {
      const path = join(canonicalDirectory, skillFile.name);
      const canonical = await realpath(path);
      if (!contained(containmentRoot, canonical)) return;
      const details = await stat(canonical);
      if (details.size > this.maxSkillBytes) return;
      const bytes = await readFile(canonical);
      const sourceRelativePath = normalize(relative(catalogRoot, canonical));
      const relativeDirectory = normalize(relative(catalogRoot, canonicalDirectory));
      const relativePath = source === "project"
        ? sourceRelativePath
        : `${source}:${sourceRelativePath}`;
      const id = `${idPrefix}${relativeDirectory}`;
      const metadata = parseMetadata(bytes.toString("utf8"), id);
      discovered.set(id, {
        id,
        name: metadata.name,
        description: metadata.description,
        relativePath,
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: details.size,
        source,
      });
      skillPaths.set(id, canonical);
      return;
    }
    // Hidden folders hold deleted (.trash), staged (.staging) or tool-internal (.system) copies;
    // the tunnel run injected four deleted Claude.ai skills into every Architect turn.
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") &&
        !(depth === 0 && excludeDirectories.includes(entry.name)))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directories) {
      if (discovered.size >= this.maxSkills) break;
      await this.walk(
        join(canonicalDirectory, entry.name),
        containmentRoot,
        catalogRoot,
        idPrefix,
        source,
        depth + 1,
        discovered,
        skillPaths
      );
    }
  }

  private async root(): Promise<string> {
    this.canonicalRoot ??= await realpath(this.projectRootInput);
    return this.canonicalRoot;
  }
}

function parseMetadata(content: string, fallbackName: string) {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const values = new Map<string, string>();
  if (frontmatter) {
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
      if (match) values.set(match[1].toLowerCase(), unquote(match[2]));
    }
  }
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = values.get("name") || heading || fallbackName.split("/").at(-1) || fallbackName;
  const description =
    values.get("description") ||
    content
      .replace(/^---[\s\S]*?---\s*/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#")) ||
    `Project skill ${name}`;
  return { name, description };
}

/** Marks every same-named skill that loses to a higher-precedence source, so callers can show which won. */
function markShadowed(skills: Map<string, SkillMetadata>): void {
  const winners = new Map<string, SkillMetadata>();
  for (const skill of skills.values()) {
    const key = skill.name.toLowerCase();
    const current = winners.get(key);
    if (!current || skillSourcePrecedence(skill) < skillSourcePrecedence(current) ||
      (skillSourcePrecedence(skill) === skillSourcePrecedence(current) && skill.id < current.id)) {
      winners.set(key, skill);
    }
  }
  for (const [id, skill] of skills) {
    const winner = winners.get(skill.name.toLowerCase());
    if (winner && winner.id !== id) skills.set(id, { ...skill, shadowedBy: winner.id });
  }
}

function unquote(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
}
function contained(root: string, candidate: string): boolean {
  const traversal = relative(root, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}
function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}
function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive.`);
}
