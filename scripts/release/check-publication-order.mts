// Deploy-time publication-order guard: the committed release manifests may only move forward.
//   npx tsx scripts/release/check-publication-order.mts --base <previously deployed commit>
// For every public/release/<channel>/manifest.json present at --base, the working tree must still have one,
// and a changed manifest must carry a strictly higher sequence. Signatures are checked by the installers and
// by `release-keys.mts verify`; this guard stops regressions and requires permanent epoch-opening files.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function sequenceOf(bytes: Buffer, where: string): { epoch: number; sequence: number } {
  const value = JSON.parse(bytes.toString("utf8")) as { schemaVersion?: unknown; epoch?: unknown; sequence?: unknown };
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || (value.schemaVersion === 1 && value.epoch !== undefined) || (value.schemaVersion === 2 && value.epoch === undefined)) throw new Error(`${where} has no valid schema and epoch.`);
  const epoch = value.epoch ?? 0;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || epoch > 2 ** 20 ||
      typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 2 ** 40) throw new Error(`${where} has no valid epoch and sequence.`);
  return { epoch, sequence: value.sequence };
}

/** Check the current tree even for a first deployment or a manual workflow dispatch. */
function checkCurrentOpenings(repository: string): void {
  const releaseRoot = join(repository, "public", "release");
  if (!existsSync(releaseRoot)) return;
  for (const channel of readdirSync(releaseRoot, { withFileTypes: true })) {
    if (!channel.isDirectory() || !/^[a-z][a-z0-9-]{0,31}$/.test(channel.name)) continue;
    const current = join(releaseRoot, channel.name, "manifest.json");
    if (!existsSync(current)) continue;
    const servedBytes = readFileSync(current);
    const served = JSON.parse(servedBytes.toString("utf8")) as { signingKeys?: unknown };
    const epoch = sequenceOf(servedBytes, current).epoch;
    for (let next = 1; next <= epoch; next += 1) {
      const opening = join(dirname(current), `epoch-${next}.json`);
      if (!existsSync(opening) || !existsSync(`${opening}.sig`)) throw new Error(`${opening} and its signature must be published with the new epoch.`);
      const bytes = readFileSync(opening);
      const value = JSON.parse(bytes.toString("utf8")) as { signingKeys?: unknown };
      if (sequenceOf(bytes, opening).epoch !== next || !Array.isArray(value.signingKeys) || !value.signingKeys.length || !readFileSync(`${opening}.sig`).length) {
        throw new Error(`${opening} is not an epoch-opening manifest with a signature.`);
      }
      if (next === epoch && Array.isArray(served.signingKeys) && served.signingKeys.length &&
          (!servedBytes.equals(bytes) || !existsSync(`${current}.sig`) || !readFileSync(`${current}.sig`).equals(readFileSync(`${opening}.sig`)))) {
        throw new Error(`${opening} must match the served epoch-opening manifest and signature.`);
      }
    }
  }
}

/** Returns a description of each checked channel; throws if any committed manifest regressed. */
export function checkPublicationOrder(repository: string, base: string): string[] {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] });
  const paths = git(["ls-tree", "-r", "--name-only", base, "--", "public/release"]).toString("utf8").split("\n");
  const histories = paths.filter((path) => /^public\/release\/[a-z][a-z0-9-]{0,31}\/epoch-[1-9][0-9]*\.json(?:\.sig)?$/.test(path));
  for (const path of histories) {
    const current = join(repository, ...path.split("/"));
    if (!existsSync(current) || !readFileSync(current).equals(git(["show", `${base}:${path}`]))) {
      throw new Error(`${path} is permanent release recovery history and cannot be removed or changed.`);
    }
  }
  checkCurrentOpenings(repository);
  const listed = paths.filter((path) => /^public\/release\/[a-z][a-z0-9-]{0,31}\/manifest\.json$/.test(path));
  const notes: string[] = [];
  for (const path of listed) {
    const before = git(["show", `${base}:${path}`]);
    const current = join(repository, ...path.split("/"));
    if (!existsSync(current)) throw new Error(`${path} was removed; a published manifest can only be replaced by a newer one.`);
    const after = readFileSync(current);
    if (after.equals(before)) { notes.push(`${path}: unchanged`); continue; }
    const [from, to] = [sequenceOf(before, `${path} at ${base}`), sequenceOf(after, path)];
    const display = (value: { epoch: number; sequence: number }) => value.epoch === 0 ? String(value.sequence) : `${value.epoch}:${value.sequence}`;
    if (to.epoch < from.epoch || (to.epoch === from.epoch && to.sequence <= from.sequence)) throw new Error(`${path} sequence ${display(to)} does not exceed the previously deployed ${display(from)}; publish drafts in sequence order.`);
    if (to.epoch > from.epoch) {
      if (to.epoch !== from.epoch + 1) throw new Error(`${path} must publish each epoch in order.`);
    }
    notes.push(`${path}: ${display(from)} -> ${display(to)}`);
  }
  return notes;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const index = process.argv.indexOf("--base");
  const base = index < 0 ? undefined : process.argv[index + 1];
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (!base || /^0+$/.test(base)) {
    checkCurrentOpenings(repository);
    process.stdout.write("No previously deployed commit; current recovery history checked.\n");
  }
  else for (const note of checkPublicationOrder(repository, base)) process.stdout.write(`${note}\n`);
}
