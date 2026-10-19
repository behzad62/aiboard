import type { GitRunner } from "./git-repository.js";
import { isAbsolute, relative } from "node:path";
import { assertSubmissionHasNoSecrets, inspectSubmissionScope, type SubmissionFile, type SubmissionScopeFinding } from "./submission-guard.js";
import type { AssignmentClaim } from "./planning-contracts.js";

const SUBMISSION_DIFF_CONCURRENCY = 8;
const ADDED_LINES_DIFF = ["diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0"];

/**
 * The added lines of every path in one diff. With --no-renames each file's section of the whole-tree
 * diff is exactly its per-file diff; a supervised Git process costs 1-3 s on Windows, and one diff per
 * file, run by several submission checks, still took a 35-file submit_task past its limit (tunnel
 * run). A path Git quotes in the section header (unusual characters) is read with its own diff.
 */
export async function addedLinesByPath(
  git: (args: readonly string[]) => Promise<string>,
  baselineRevision: string,
  revision: string,
  paths: readonly string[],
): Promise<Map<string, string[]>> {
  const whole = await git([...ADDED_LINES_DIFF, "--src-prefix=a/", "--dst-prefix=b/", baselineRevision, revision, "--"]);
  const sections = new Map<string, string[]>();
  for (const section of `\n${whole}`.split("\ndiff --git ").slice(1)) {
    const lines = section.split("\n");
    const hunk = lines.findIndex((line) => line.startsWith("@@ "));
    const header = hunk < 0 ? lines : lines.slice(0, hunk);
    const name = (prefix: string) => header.find((line) => line.startsWith(prefix))?.slice(prefix.length).replace(/\t$/, "");
    const path = name("+++ b/") ?? name("--- a/");
    if (path === undefined || path.startsWith("\"")) continue;
    sections.set(path, hunk < 0 ? [] : lines.slice(hunk).filter((line) => line.startsWith("+")).map((line) => line.slice(1)));
  }
  const result = new Map<string, string[]>();
  for (const path of paths) {
    const known = sections.get(path);
    if (known) { result.set(path, known); continue; }
    const diff = await git([...ADDED_LINES_DIFF, baselineRevision, revision, "--", `:(literal)${path}`]);
    let inHunk = false;
    const addedLines: string[] = [];
    for (const line of diff.split("\n")) {
      if (line.startsWith("@@ ")) inHunk = true;
      else if (inHunk && line.startsWith("+")) addedLines.push(line.slice(1));
    }
    result.set(path, addedLines);
  }
  return result;
}

/** Scan exact immutable tree bytes before any submitted diff artifact exists. */
export async function inspectSubmissionTree(input: {
  git: GitRunner;
  workspacePath: string;
  baselineRevision: string;
  candidateRevision: string;
  claim: Pick<AssignmentClaim, "writableSurfaces" | "forbiddenSurfaces">;
  captureInventory?: (files: Array<{ path: string; added: boolean }>) => void;
}): Promise<SubmissionScopeFinding[]> {
  const git = async (args: readonly string[]) => {
    const result = await input.git({ cwd: input.workspacePath, args, maxOutputBytes: 64 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error("Submission inventory is unavailable.");
    return result.stdout;
  };
  const inventory = await git(["diff", "--name-status", "-z", "--no-renames", input.baselineRevision, input.candidateRevision, "--"]);
  const rows = inventory.split("\0");
  if (rows.pop() !== "" || rows.length % 2) throw new Error("Submission inventory is malformed.");
  const files: SubmissionFile[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    const status = rows[index]!;
    if (!/^[AMDT]$/.test(status) || rows[index + 1]!.includes("\\")) throw new Error("Submission inventory has an unsupported path identity or status.");
    files.push({ path: rows[index + 1]!, added: status === "A", addedLines: [] });
  }
  // Key/env filename refusal precedes reading content or producing the diff.
  assertSubmissionHasNoSecrets(files);
  input.captureInventory?.(files.map(({ path, added }) => ({ path, added })));
  const added = await addedLinesByPath(git, input.baselineRevision, input.candidateRevision, files.map((file) => file.path));
  for (const file of files) file.addedLines = added.get(file.path) ?? [];
  assertSubmissionHasNoSecrets(files);
  return inspectSubmissionScope(files, localSubmissionClaim(input.claim, input.workspacePath));
}

export function localSubmissionClaim(claim: Pick<AssignmentClaim, "writableSurfaces" | "forbiddenSurfaces">, workspacePath: string): Pick<AssignmentClaim, "writableSurfaces" | "forbiddenSurfaces"> {
  const localSurface = (surface: string) => isAbsolute(surface)
    ? relative(workspacePath, surface).replaceAll("\\", "/") || "."
    : surface;
  return { writableSurfaces: claim.writableSurfaces.map(localSurface), forbiddenSurfaces: claim.forbiddenSurfaces.map(localSurface) };
}
