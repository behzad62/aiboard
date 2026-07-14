import { lstat, readdir } from "node:fs/promises";

export interface WorktreeAssociation {
  path: string;
  branch?: string;
  prunable: boolean;
}

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
      current = {
        path: field.slice("worktree ".length),
        prunable: false,
      };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    } else if (field.startsWith("prunable ") && current) {
      current.prunable = true;
    }
  }
  if (current) associations.push(current);
  return associations;
}

export async function isEmptyDirectory(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}
