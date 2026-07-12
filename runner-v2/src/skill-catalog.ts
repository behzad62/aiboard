import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  relativePath: string;
  digest: string;
  byteLength: number;
  source: "project" | "built-in" | "user";
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
}

export interface SharedSkillRoot {
  path: string;
  source: "built-in" | "user";
}

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
    assertPositive(this.maxSkills, "maxSkills");
    assertPositive(this.maxDepth, "maxDepth");
    assertPositive(this.maxSkillBytes, "maxSkillBytes");
  }

  async discover(): Promise<SkillMetadata[]> {
    const root = await this.root();
    const discovered = new Map<string, SkillMetadata>();
    this.skillPaths = new Map();
    for (const configured of this.roots) {
      if (isAbsolute(configured) || configured.split(/[\\/]+/).includes("..")) {
        throw new Error(`Skill root ${configured} must be project-relative.`);
      }
      const searchRoot = resolve(root, configured);
      if (!contained(root, searchRoot)) throw new Error(`Skill root ${configured} escapes project.`);
      await this.walk(searchRoot, root, root, "", "project", 0, discovered);
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
        discovered
      );
    }
    this.cache = discovered;
    return [...discovered.values()].sort((left, right) => left.id.localeCompare(right.id));
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
    discovered: Map<string, SkillMetadata>
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
      this.skillPaths.set(id, canonical);
      return;
    }
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
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
        discovered
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
