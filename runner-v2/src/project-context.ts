import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ProjectInstructionSource {
  relativePath: string;
  scopeDirectory: string;
  digest: string;
  byteLength: number;
  content: string;
}

export interface DiscoverProjectInstructionsOptions {
  projectRoot: string;
  targetPath?: string;
  maxSourceBytes?: number;
  maxTotalBytes?: number;
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export async function discoverProjectInstructions(
  options: DiscoverProjectInstructionsOptions
): Promise<ProjectInstructionSource[]> {
  const root = await realpath(resolve(options.projectRoot));
  const targetInput = resolve(options.targetPath ?? root);
  const targetDetails = await stat(targetInput);
  const target = await realpath(targetDetails.isDirectory() ? targetInput : dirname(targetInput));
  assertContained(root, target, "Target path is outside project.");
  const maxSourceBytes = options.maxSourceBytes ?? 256 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024;
  assertPositive(maxSourceBytes, "maxSourceBytes");
  assertPositive(maxTotalBytes, "maxTotalBytes");

  const traversal = relative(root, target);
  const segments = traversal ? traversal.split(/[\\/]+/).filter(Boolean) : [];
  const directories = [root];
  for (let index = 1; index <= segments.length; index += 1) {
    directories.push(join(root, ...segments.slice(0, index)));
  }

  const sources: ProjectInstructionSource[] = [];
  let totalBytes = 0;
  for (const directory of directories) {
    for (const filename of INSTRUCTION_FILES) {
      const path = join(directory, filename);
      let details;
      try {
        details = await stat(path);
      } catch {
        continue;
      }
      if (!details.isFile()) continue;
      const canonical = await realpath(path);
      assertContained(root, canonical, `Instruction ${path} escapes project.`);
      if (details.size > maxSourceBytes) {
        throw new Error(`Instruction ${normalize(relative(root, path))} exceeds maxSourceBytes.`);
      }
      if (totalBytes + details.size > maxTotalBytes) {
        throw new Error("Project instructions exceed maxTotalBytes.");
      }
      const bytes = await readFile(canonical);
      totalBytes += bytes.byteLength;
      sources.push({
        relativePath: normalize(relative(root, canonical)),
        scopeDirectory: normalize(relative(root, directory)),
        digest: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        content: bytes.toString("utf8"),
      });
    }
  }
  return sources;
}

function assertContained(root: string, candidate: string, message: string): void {
  const traversal = relative(root, candidate);
  if (traversal.startsWith("..") || isAbsolute(traversal)) throw new Error(message);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}
