import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorktreeAssociation {
  path: string;
  branch?: string;
}

export type OwnedWorktreeAssociationState = "none" | "exact" | "unexpected";

export function parseWorktreeAssociations(output: string): WorktreeAssociation[] {
  const associations: WorktreeAssociation[] = [];
  let current: WorktreeAssociation | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) associations.push(current);
      current = undefined;
      continue;
    }
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) associations.push(current);
  return associations;
}

export function classifyOwnedWorktreeAssociations(
  associations: readonly WorktreeAssociation[],
  expectedBranch: string,
  expectedPath: string
): OwnedWorktreeAssociationState {
  const branchAssociations = associations.filter(
    (association) => association.branch === expectedBranch
  );
  const pathAssociations = associations.filter(
    (association) => resolve(association.path) === expectedPath
  );
  if (branchAssociations.length === 0 && pathAssociations.length === 0) {
    return "none";
  }
  if (
    branchAssociations.length === 1 &&
    pathAssociations.length === 1 &&
    branchAssociations[0] === pathAssociations[0]
  ) {
    return "exact";
  }
  return "unexpected";
}

export async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}
