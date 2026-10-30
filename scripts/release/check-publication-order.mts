// Deploy-time publication-order guard: the committed release manifests may only move forward.
//   npx tsx scripts/release/check-publication-order.mts --base <previously deployed commit>
// For every public/release/<channel>/manifest.json present at --base, the working tree must still have one,
// and a changed manifest must carry a strictly higher sequence. Signatures are checked by the installers and
// by `release-keys.mts verify`; this guard only stops an older draft (or a removal) from lowering the
// installers' replay floor after a newer release was published.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function sequenceOf(bytes: Buffer, where: string): number {
  const value = JSON.parse(bytes.toString("utf8")) as { sequence?: unknown };
  if (!Number.isSafeInteger(value.sequence)) throw new Error(`${where} has no valid sequence.`);
  return value.sequence as number;
}

/** Returns a description of each checked channel; throws if any committed manifest regressed. */
export function checkPublicationOrder(repository: string, base: string): string[] {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
  const listed = git(["ls-tree", "-r", "--name-only", base, "--", "public/release"]).toString("utf8").split("\n")
    .filter((path) => /^public\/release\/[a-z][a-z0-9-]{0,31}\/manifest\.json$/.test(path));
  const notes: string[] = [];
  for (const path of listed) {
    const before = git(["show", `${base}:${path}`]);
    const current = join(repository, ...path.split("/"));
    if (!existsSync(current)) throw new Error(`${path} was removed; a published manifest can only be replaced by a newer one.`);
    const after = readFileSync(current);
    if (after.equals(before)) { notes.push(`${path}: unchanged`); continue; }
    const [from, to] = [sequenceOf(before, `${path} at ${base}`), sequenceOf(after, path)];
    if (to <= from) throw new Error(`${path} sequence ${to} does not exceed the previously deployed ${from}; publish drafts in sequence order.`);
    notes.push(`${path}: ${from} -> ${to}`);
  }
  return notes;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const index = process.argv.indexOf("--base");
  const base = index < 0 ? undefined : process.argv[index + 1];
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (!base || /^0+$/.test(base)) process.stdout.write("No previously deployed commit; publication order not checked.\n");
  else for (const note of checkPublicationOrder(repository, base)) process.stdout.write(`${note}\n`);
}
