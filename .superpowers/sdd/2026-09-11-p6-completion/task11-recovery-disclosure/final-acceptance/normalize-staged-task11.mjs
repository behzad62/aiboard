import fs from "node:fs";
import cp from "node:child_process";

const evidencePrefix = ".superpowers/sdd/2026-09-11-p6-completion/task11-recovery-disclosure/";
const staged = cp.execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { encoding: "utf8" })
  .split("\0").filter((file) => file && !file.startsWith(evidencePrefix));
const mismatches = [];
const unsafe = [];
for (const file of staged) {
  if (!fs.existsSync(file)) continue;
  const working = fs.readFileSync(file);
  const indexed = cp.execFileSync("git", ["show", `:${file}`]);
  if (working.equals(indexed)) continue;
  const normalized = Buffer.from(working.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const item = { path: file, workingBytes: working.length, stagedBytes: indexed.length };
  mismatches.push(item);
  if (!normalized.equals(indexed)) unsafe.push(item);
}
if (unsafe.length) {
  console.error(JSON.stringify({ mismatches, unsafe }, null, 2));
  process.exit(1);
}
for (const item of mismatches) fs.writeFileSync(item.path, cp.execFileSync("git", ["show", `:${item.path}`]));
const remaining = staged.filter((file) => fs.existsSync(file) &&
  !fs.readFileSync(file).equals(cp.execFileSync("git", ["show", `:${file}`])));
const result = { stagedCodeCount: staged.length, mismatchCount: mismatches.length,
  allLineEndingOnly: true, normalizedPaths: mismatches, remaining };
fs.writeFileSync(`${evidencePrefix}final-acceptance/task11-line-ending-normalization.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (remaining.length) process.exit(1);
