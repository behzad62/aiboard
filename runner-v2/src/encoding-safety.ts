import { createHash } from "node:crypto";
import type { GitRunner } from "./git-repository.js";
import type { GitBinaryRunner } from "./git-command.js";
import { reviewChangeSetId } from "./review-integrity.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const hasBom = (bytes: Buffer) => bytes.subarray(0, 3).equals(BOM);
export function preserveUtf8Bom(original: Buffer, replacement: Buffer): Buffer {
  return hasBom(original) && !hasBom(replacement) ? Buffer.concat([BOM, replacement]) : replacement;
}
export const ENCODING_FINDING_CODES = ["bom_added", "bom_removed", "line_endings_flipped", "mixed_endings_introduced", "replacement_character", "mojibake", "invalid_utf8"] as const;
export type EncodingFindingCode = typeof ENCODING_FINDING_CODES[number];
export interface EncodingFileFact {
  path: string;
  baselineSha256: string | null;
  candidateSha256: string;
  codes: EncodingFindingCode[];
}
export interface EncodingSubmissionRecord {
  version: 1; runId: string; taskId: string; baselineRevision: string; taskRevision: string; changeSetId: string;
  files: EncodingFileFact[];
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function decode(bytes: Buffer): string | undefined {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}
function endings(text: string): string[] {
  const result = new Set<string>();
  for (const match of text.matchAll(/\r\n|\r|\n/g)) result.add(match[0]);
  return [...result].sort();
}
/** Mechanical deltas only: pre-existing suspicious lines are not new damage. */
export function inspectEncodingDelta(path: string, baseline: Buffer | null, candidate: Buffer, addedLines?: readonly string[]): EncodingFileFact | undefined {
  const textIdentity = /\.(?:[cm]?[jt]sx?|json|md|txt|ya?ml|toml|ini|xml|html?|css|scss|sql|sh|ps1|bat|cmd|py|rs|go|java|cs|fs|vb|c|h|cc|cpp|hpp|hxx|hh|kt|swift|rb|php|csv|svg|env)$/i.test(path) || /(?:^|\/)(?:Dockerfile|Makefile|LICENSE|README|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.nvmrc|\.yarnrc)$/i.test(path);
  const current = decode(candidate); const previous = baseline ? decode(baseline) : "";
  const binaryIdentity = /\.(?:pdf|png|jpe?g|gif|webp|ico|bmp|tiff?|zip|gz|bz2|xz|7z|rar|woff2?|ttf|otf|mp[34]|wav|ogg|mov|avi|exe|dll|so|dylib|bin)$/i.test(path);
  const priorText = baseline !== null && previous !== undefined && !baseline.includes(0);
  const encodedTextBom = candidate.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) || candidate.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]));
  // Existing valid text establishes text identity even for an unknown filename.
  // A binary predecessor cannot hide a valid UTF-8 text candidate.
  if (!textIdentity && !priorText && !encodedTextBom && (candidate.includes(0) || binaryIdentity && current === undefined)) return undefined;
  const codes: EncodingFindingCode[] = [];
  if (current === undefined || candidate.includes(0)) codes.push("invalid_utf8");
  if ((baseline ? hasBom(baseline) : false) !== hasBom(candidate)) codes.push(hasBom(candidate) ? "bom_added" : "bom_removed");
  if (current !== undefined) {
    const before = previous === undefined ? [] : endings(previous); const after = endings(current);
    if (before.length === 1 && after.length === 1 && before[0] !== after[0]) codes.push("line_endings_flipped");
    if (before.length < 2 && after.length > 1) codes.push("mixed_endings_introduced");
    // Production supplies exact added Git hunks. Pure callers conservatively
    // inspect the changed range between common prefix/suffix lines.
    const oldLines = (previous ?? "").split(/\r\n|\r|\n/); const newLines = current.split(/\r\n|\r|\n/);
    let first = 0; let oldEnd = oldLines.length; let newEnd = newLines.length;
    while (first < oldEnd && first < newEnd && oldLines[first] === newLines[first]) first++;
    while (oldEnd > first && newEnd > first && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
    const added = addedLines ?? newLines.slice(first, newEnd);
    if (added.some((line) => line.includes("\ufffd"))) codes.push("replacement_character");
    if (added.some((line) => /\u00c3|\u00e2\u20ac|\u00c2/.test(line))) codes.push("mojibake");
  }
  return { path, baselineSha256: baseline ? hash(baseline) : null, candidateSha256: hash(candidate), codes };
}

/** Exact blob bytes from owned Git, independent of checkout filters and dirty files. */
export async function captureEncodingSubmission(input: {
  git: GitRunner; gitBytes: GitBinaryRunner; workspacePath: string; runId: string; taskId: string; baselineRevision: string; taskRevision: string;
}): Promise<EncodingSubmissionRecord> {
  const text = async (args: string[]) => {
    const result = await input.git({ cwd: input.workspacePath, args, maxOutputBytes: 64 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error("Encoding inventory unavailable."); return result.stdout;
  };
  const rows = (await text(["diff", "--name-status", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", input.baselineRevision, input.taskRevision, "--"])).split("\0");
  if (rows.pop() !== "" || rows.length % 2) throw new Error("Encoding inventory malformed.");
  const blob = async (revision: string, path: string) => {
    const result = await input.gitBytes({ cwd: input.workspacePath, args: ["show", `${revision}:${path}`], maxOutputBytes: 64 * 1024 * 1024 });
    if (result.exitCode !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("Encoding byte inventory unavailable."); return result.stdout;
  };
  const files: EncodingFileFact[] = [];
  for (let index = 0; index < rows.length; index += 2) {
    const status = rows[index]!; const path = rows[index + 1]!;
    if (!/^[AMDT]$/.test(status) || !safePath(path)) throw new Error("Unsupported encoding inventory identity.");
    if (status === "D") continue;
    const diff = await text(["diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", input.baselineRevision, input.taskRevision, "--", `:(literal)${path}`]);
    const added: string[] = []; let inHunk = false;
    for (const line of diff.split("\n")) { if (line.startsWith("@@ ")) inHunk = true; else if (inHunk && line.startsWith("+")) added.push(line.slice(1)); }
    const fact = inspectEncodingDelta(path, status === "A" ? null : await blob(input.baselineRevision, path), await blob(input.taskRevision, path), added);
    if (fact) files.push(fact);
  }
  return { version: 1, runId: input.runId, taskId: input.taskId, baselineRevision: input.baselineRevision, taskRevision: input.taskRevision,
    changeSetId: reviewChangeSetId(input.runId, input.taskId, input.taskRevision), files };
}
export function validateEncodingSubmission(value: unknown, identity: { runId: string; taskId: string; baselineRevision: string; changeSetId: string }): EncodingSubmissionRecord {
  const record = value as EncodingSubmissionRecord | undefined;
  if (!record || record.version !== 1 || record.runId !== identity.runId || record.taskId !== identity.taskId || record.baselineRevision !== identity.baselineRevision ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.taskRevision) || record.changeSetId !== identity.changeSetId || record.changeSetId !== reviewChangeSetId(identity.runId, identity.taskId, record.taskRevision) ||
    !Array.isArray(record.files) || record.files.length > 10_000 || record.files.some((file) => !file || typeof file.path !== "string" || !safePath(file.path) ||
      file.baselineSha256 !== null && !/^[a-f0-9]{64}$/.test(file.baselineSha256) || !/^[a-f0-9]{64}$/.test(file.candidateSha256) || !Array.isArray(file.codes) ||
      file.codes.some((code) => !ENCODING_FINDING_CODES.includes(code)) || new Set(file.codes).size !== file.codes.length) || new Set(record.files.map((file) => file.path)).size !== record.files.length) throw new Error("Encoding submission differs from exact runner authority.");
  return structuredClone(record);
}
export function encodingFindingFacts(record: EncodingSubmissionRecord): Array<{ id: string; path: string; message: string }> {
  return record.files.flatMap((file) => file.codes.map((code) => ({ path: file.path, message: `Encoding change detected: ${code}. Inspect the committed bytes and justify or repair the change.`,
    id: `submission-encoding:${createHash("sha256").update(JSON.stringify([record.runId, record.taskId, record.changeSetId, file.path, code, file.baselineSha256, file.candidateSha256])).digest("hex")}` })));
}
function safePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split("/").some((part) => !part || part === "." || part === "..");
}
