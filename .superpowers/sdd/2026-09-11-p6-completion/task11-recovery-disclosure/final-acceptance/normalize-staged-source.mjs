import fs from "node:fs";
import cp from "node:child_process";

const prefix = ".superpowers/sdd/2026-09-11-p6-completion/task11-recovery-disclosure/final-acceptance/";
const freeze = JSON.parse(fs.readFileSync(`${prefix}source-freeze.json`, "utf8").replace(/^\uFEFF/, ""));
const mismatches = [];
const unsafe = [];
for (const file of freeze.files) {
  const working = fs.readFileSync(file.path);
  const staged = cp.execFileSync("git", ["show", `:${file.path}`]);
  if (working.equals(staged)) continue;
  const normalized = Buffer.from(working.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  const item = { path: file.path, workingBytes: working.length, stagedBytes: staged.length };
  mismatches.push(item);
  if (!normalized.equals(staged)) unsafe.push(item);
}
if (unsafe.length) {
  console.error(JSON.stringify({ mismatches, unsafe }, null, 2));
  process.exit(1);
}
for (const item of mismatches) {
  fs.writeFileSync(item.path, cp.execFileSync("git", ["show", `:${item.path}`]));
}
const remaining = freeze.files.filter((file) =>
  !fs.readFileSync(file.path).equals(cp.execFileSync("git", ["show", `:${file.path}`]))
).map((file) => file.path);
const result = { mismatchCount: mismatches.length, allLineEndingOnly: true, normalizedPaths: mismatches, remaining };
fs.writeFileSync(`${prefix}source-line-ending-normalization.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (remaining.length) process.exit(1);
