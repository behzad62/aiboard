import fs from "node:fs";
import crypto from "node:crypto";
import cp from "node:child_process";

const prefix = ".superpowers/sdd/2026-09-11-p6-completion/task11-recovery-disclosure/";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const log = fs.readFileSync(`${prefix}final-acceptance/staged-diff-check.log`, "utf8")
  .replace(/^\uFEFF/, "").split(/\r?\n/);
const warningPaths = [...new Set(log.map((line) => {
  const match = line.match(/^(.+?):\d+: (?:trailing whitespace|new blank line at EOF)/);
  return match?.[1];
}).filter(Boolean))];
const outsideWarnings = warningPaths.filter((file) => !file.startsWith(prefix));
const freeze = readJson(`${prefix}final-acceptance/source-freeze.json`);
const source = freeze.files.map((file) => {
  const working = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
  const staged = crypto.createHash("sha256").update(cp.execFileSync("git", ["show", `:${file.path}`])).digest("hex");
  return { path: file.path, expected: file.sha256, working, staged,
    ok: working === file.sha256 && staged === file.sha256 };
});
const objectFormat = cp.execFileSync("git", ["rev-parse", "--show-object-format"], { encoding: "utf8" }).trim();
const indexRows = cp.execFileSync("git", ["ls-files", "-s", "-z", "--", prefix], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const evidenceMismatches = [];
for (const row of indexRows) {
  const match = row.match(/^(\d+) ([0-9a-f]+) (\d+)\t(.+)$/);
  if (!match || match[3] !== "0" || !fs.existsSync(match[4])) continue;
  const bytes = fs.readFileSync(match[4]);
  const header = Buffer.from(`blob ${bytes.length}\0`);
  const rawOid = crypto.createHash(objectFormat).update(header).update(bytes).digest("hex");
  if (rawOid !== match[2]) evidenceMismatches.push({ path: match[4], index: match[2], raw: rawOid });
}
const result = {
  warningPathCount: warningPaths.length,
  allWhitespaceWarningsEvidenceOnly: outsideWarnings.length === 0,
  outsideWarningPaths: outsideWarnings,
  sourceFreezeVerified: source.every((item) => item.ok),
  sourceCount: source.length,
  sourceMismatches: source.filter((item) => !item.ok),
  evidenceIndexedCount: indexRows.length,
  evidenceRawByteMismatches: evidenceMismatches,
};
fs.writeFileSync(`${prefix}final-acceptance/staged-byte-audit.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (outsideWarnings.length || !result.sourceFreezeVerified || evidenceMismatches.length) process.exit(1);
