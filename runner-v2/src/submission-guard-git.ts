import type { GitRunner } from "./git-repository.js";
import { isAbsolute, relative } from "node:path";
import { assertSubmissionHasNoSecrets, inspectSubmissionScope, type SubmissionFile, type SubmissionScopeFinding } from "./submission-guard.js";
import type { AssignmentClaim } from "./planning-contracts.js";

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
  for (const file of files) {
    const diff = await git(["diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", input.baselineRevision, input.candidateRevision, "--", `:(literal)${file.path}`]);
    let inHunk = false;
    const addedLines: string[] = [];
    for (const line of diff.split("\n")) {
      if (line.startsWith("@@ ")) inHunk = true;
      else if (inHunk && line.startsWith("+")) addedLines.push(line.slice(1));
    }
    file.addedLines = addedLines;
  }
  assertSubmissionHasNoSecrets(files);
  return inspectSubmissionScope(files, localSubmissionClaim(input.claim, input.workspacePath));
}

export function localSubmissionClaim(claim: Pick<AssignmentClaim, "writableSurfaces" | "forbiddenSurfaces">, workspacePath: string): Pick<AssignmentClaim, "writableSurfaces" | "forbiddenSurfaces"> {
  const localSurface = (surface: string) => isAbsolute(surface)
    ? relative(workspacePath, surface).replaceAll("\\", "/") || "."
    : surface;
  return { writableSurfaces: claim.writableSurfaces.map(localSurface), forbiddenSurfaces: claim.forbiddenSurfaces.map(localSurface) };
}
