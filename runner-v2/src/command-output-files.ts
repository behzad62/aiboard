import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, posix, resolve, win32 } from "node:path";

import type { ToolExecutionOutput } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import { compileGlobs, SearchError } from "./filesystem-search.js";
import { detectImageType, IMAGE_LIMITS } from "./image-inspection.js";
import { visualArtifactOutput } from "./image-tools.js";
import { runnerOwnedPathContains } from "./runner-owned-roots.js";
import { MAX_TOOL_VISUALS_PER_REQUEST } from "./tool-visual-input.js";

/**
 * Files a command leaves behind (screenshots, test reports, logs) kept as evidence (VF6).
 *
 * The caller names workspace-relative paths or simple globs; after the command has exited and its
 * process tree is verified gone, the Runner reads the matching files and stores them as artifacts
 * linked to the evidence record. Nothing here decides what a file means: a path that matches nothing
 * is recorded as missing, and a file the Runner will not read is recorded as refused, with the reason.
 * Shared by run_evidence_command and, later, the final verification checks (VF3).
 */
export interface CommandOutputLimits {
  readonly maxPatterns: number;
  readonly maxPatternLength: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxScanEntries: number;
}

export const COMMAND_OUTPUT_LIMITS: CommandOutputLimits = Object.freeze({
  /** Paths or globs per command. */
  maxPatterns: 16,
  maxPatternLength: 256,
  /** Files stored per command. */
  maxFiles: 32,
  /** One file; equal to the image source bound, so a stored screenshot can always be prepared. */
  maxFileBytes: IMAGE_LIMITS.maxSourceBytes,
  /** All files of one command together. */
  maxTotalBytes: 64 * 1024 * 1024,
  /** Directory entries the globs of one command may read together. */
  maxScanEntries: 10_000,
});

/** Directories a wildcard (`*`, `**`) never descends into; a literal path segment may still name them. */
const WILDCARD_SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface CommandOutputFile {
  /** Workspace-relative, `/`-separated, as matched. */
  path: string;
  artifactHash: string;
  mediaType: string;
  byteLength: number;
}

export type CommandOutputRefusalReason =
  | "outside_workspace"
  | "hidden"
  | "not_a_file"
  | "file_too_large"
  | "file_cap"
  | "total_size_cap"
  | "scan_cap"
  | "changed_while_reading"
  | "unreadable";

export interface CommandOutputRefusal {
  /** The matched path, or the pattern itself for `scan_cap`. */
  path: string;
  reason: CommandOutputRefusalReason;
  byteLength?: number;
}

export interface CommandOutputCapture {
  /** The normalized patterns, in the caller's order. */
  requested: string[];
  files: CommandOutputFile[];
  /** Requested patterns that matched nothing. Not an error. */
  missing: string[];
  /** Matched paths the Runner did not store, with the reason. */
  refused?: CommandOutputRefusal[];
  /** Set when no file was read: the command's process tree was not proven gone, or no command ran. */
  notCaptured?: "process_not_proven_ended" | "reused_execution";
}

export type OutputPatternValidation =
  | { ok: true; patterns: string[] }
  | { ok: false; issues: string[] };

/**
 * Lexical validation before anything runs: workspace-relative only, no `..`, no absolute, drive,
 * UNC or home paths, no `:` (drive letters, Windows alternate streams). Links that lead out are
 * refused later, when the files exist.
 */
export function normalizeOutputPatterns(value: unknown): OutputPatternValidation {
  if (!Array.isArray(value)) return { ok: false, issues: ["outputs must be an array of workspace-relative paths or globs"] };
  if (value.length > COMMAND_OUTPUT_LIMITS.maxPatterns) {
    return { ok: false, issues: [`outputs accepts at most ${COMMAND_OUTPUT_LIMITS.maxPatterns} paths or globs`] };
  }
  const issues: string[] = [];
  const patterns: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) { issues.push("each output must be a non-empty string"); continue; }
    const shown = JSON.stringify(entry.length > 60 ? `${entry.slice(0, 60)}…` : entry);
    if (entry.length > COMMAND_OUTPUT_LIMITS.maxPatternLength) {
      issues.push(`output ${shown} is longer than ${COMMAND_OUTPUT_LIMITS.maxPatternLength} characters`);
      continue;
    }
    // eslint-disable-next-line no-control-regex -- control characters are refused, not matched
    if (/[\u0000-\u001f]/.test(entry)) { issues.push(`output ${shown} contains a control character`); continue; }
    const slashed = entry.trim().replace(/\\/g, "/");
    if (posix.isAbsolute(slashed) || win32.isAbsolute(slashed) || slashed.includes(":") || slashed.startsWith("~")) {
      issues.push(`output ${shown} must be a path relative to the workspace (no absolute, drive, home or ':' paths)`);
      continue;
    }
    const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
    if (segments.includes("..")) { issues.push(`output ${shown} must stay inside the workspace (no ..)`); continue; }
    if (!segments.length) { issues.push(`output ${shown} names the whole workspace; name files or a glob such as dir/**`); continue; }
    try {
      for (const segment of segments) if (isGlobSegment(segment)) compileGlobs([segment], "outputs");
    } catch (error) {
      issues.push(error instanceof SearchError ? `output ${shown}: ${error.message}` : `output ${shown} is not a valid glob`);
      continue;
    }
    const normalized = segments.join("/");
    if (!patterns.includes(normalized)) patterns.push(normalized);
  }
  return issues.length ? { ok: false, issues } : { ok: true, patterns };
}

export interface CaptureCommandOutputsInput {
  /** The command's workspace; every stored file's canonical path must stay inside it. */
  workspace: string;
  patterns: readonly string[];
  artifacts: ArtifactStore;
  /** Prefix for artifact labels, e.g. the evidence label. */
  label: string;
  /** Hidden-path policy (benchmark hidden tests); a hidden file is refused, never read. */
  isHidden?: (absolutePath: string) => Promise<boolean>;
  /** Tighter bounds for one caller (tests); never above COMMAND_OUTPUT_LIMITS. */
  limits?: Partial<Pick<OutputLimits, "maxFiles" | "maxFileBytes" | "maxTotalBytes" | "maxScanEntries">>;
}

type OutputLimits = CommandOutputLimits;

/** The process facts that decide whether a command's files may be read. */
export interface CommandOutputProcessFacts {
  outcome: string;
  cleanup: { state: string };
  /** The result answers from earlier evidence; nothing ran now. */
  reused?: boolean;
}

/**
 * Why a finished command's files may not be read, or undefined when they may: only after the
 * command's process tree is verified gone, so nothing it started can still be writing them.
 */
export function outputCaptureBlocker(process: CommandOutputProcessFacts): CommandOutputCapture["notCaptured"] | undefined {
  if (process.reused) return "reused_execution";
  if (!["exited", "timed_out", "cancelled"].includes(process.outcome) || process.cleanup.state !== "verified_empty") {
    return "process_not_proven_ended";
  }
  return undefined;
}

export function outputsNotCaptured(patterns: readonly string[], reason: NonNullable<CommandOutputCapture["notCaptured"]>): CommandOutputCapture {
  return { requested: [...patterns], files: [], missing: [], notCaptured: reason };
}

/**
 * Read the files that match `patterns` and store them as artifacts. Call it only once the command
 * has exited (outputCaptureBlocker). Reads are bounded by COMMAND_OUTPUT_LIMITS; a file is read only
 * through its canonical path after the containment check, and only when it is a regular file.
 */
export async function captureCommandOutputs(input: CaptureCommandOutputsInput): Promise<CommandOutputCapture> {
  const limits = tighterLimits(input.limits);
  const root = await realpath(resolve(input.workspace));
  const files: CommandOutputFile[] = [];
  const refused: CommandOutputRefusal[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const scan = { entries: 0 };
  let totalBytes = 0;
  for (const pattern of input.patterns) {
    const segments = pattern.split("/");
    const literal = !segments.some(isGlobSegment);
    const expansion = await expandPattern(root, segments, scan, limits.maxScanEntries);
    let matched = expansion.outside.length > 0;
    for (const path of expansion.outside) {
      if (seen.has(path)) continue;
      seen.add(path);
      refused.push({ path, reason: "outside_workspace" });
    }
    for (const path of expansion.candidates) {
      const outcome = await inspectCandidate(root, path, limits.maxFileBytes, input.isHidden);
      if (outcome.kind === "absent") continue;
      matched = true;
      if (seen.has(path)) continue;
      seen.add(path);
      if (outcome.kind === "directory") {
        // A glob passes over folders; a literal path that names one is reported, not silently dropped.
        if (literal) refused.push({ path, reason: "not_a_file" });
        continue;
      }
      if (outcome.kind === "refused") {
        refused.push({ path, reason: outcome.reason, ...(outcome.byteLength !== undefined ? { byteLength: outcome.byteLength } : {}) });
        continue;
      }
      if (files.length >= limits.maxFiles) { refused.push({ path, reason: "file_cap", byteLength: outcome.size }); continue; }
      if (totalBytes + outcome.size > limits.maxTotalBytes) {
        refused.push({ path, reason: "total_size_cap", byteLength: outcome.size });
        continue;
      }
      const read = await readContained(root, outcome.canonical, outcome.size);
      if (read.kind === "refused") { refused.push({ path, reason: read.reason }); continue; }
      totalBytes += read.bytes.byteLength;
      const mediaType = outputMediaType(read.bytes, path);
      const stored = await input.artifacts.put(read.bytes, mediaType, `${input.label} output ${path}`);
      files.push({ path, artifactHash: stored.hash, mediaType, byteLength: read.bytes.byteLength });
    }
    // An incomplete walk can neither prove a match is missing nor list every match.
    if (expansion.capped) refused.push({ path: pattern, reason: "scan_cap" });
    else if (!matched) missing.push(pattern);
  }
  return {
    requested: [...input.patterns],
    files,
    missing,
    ...(refused.length ? { refused } : {}),
  };
}

/** Artifact hashes of stored output files; empty for an older record without outputs. */
export function commandOutputArtifactHashes(outputs: CommandOutputCapture | undefined): string[] {
  return Array.isArray(outputs?.files) ? outputs.files.map((file) => file.artifactHash) : [];
}

const DELIVERABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function isDeliverableImageOutput(file: CommandOutputFile): boolean {
  return DELIVERABLE_IMAGES.has(file.mediaType);
}

/**
 * Image outputs for the model that ran or inspects the evidence, the way image.inspect and
 * browser.screenshot deliver them: an image-capable model gets visual artifact blocks (native image
 * input in its next turn), at most MAX_TOOL_VISUALS_PER_REQUEST in the requested order; a text-only
 * model gets no blocks and keeps the file reference in the record.
 */
export async function commandOutputVisualBlocks(
  artifacts: ArtifactStore,
  outputs: CommandOutputCapture | undefined,
  imageInput: boolean,
): Promise<{ blocks: ToolExecutionOutput["content"]; shown: string[] }> {
  if (!imageInput || !Array.isArray(outputs?.files)) return { blocks: [], shown: [] };
  const blocks: ToolExecutionOutput["content"] = [];
  const shown: string[] = [];
  for (const file of outputs.files.filter(isDeliverableImageOutput)) {
    if (shown.length >= MAX_TOOL_VISUALS_PER_REQUEST) break;
    let bytes: Buffer;
    try { bytes = await artifacts.get(file.artifactHash); } catch { continue; }
    const visual = await visualArtifactOutput(artifacts, bytes, `Output ${file.path}`);
    if (!visual) continue;
    blocks.push(visual.block);
    shown.push(file.path);
  }
  return { blocks, shown };
}

/**
 * One short line for the model next to the record (which already lists every file with its hash):
 * the counts, and whether the images were shown to it.
 */
export function commandOutputSummary(outputs: CommandOutputCapture, shown: readonly string[], imageInput: boolean): string {
  if (outputs.notCaptured) {
    return `outputs: not captured (${outputs.notCaptured === "reused_execution"
      ? "the command was not run again, so it produced no new files"
      : "the command's process tree was not proven ended, so its files were not read"}).`;
  }
  const images = outputs.files.filter(isDeliverableImageOutput);
  const parts = [`outputs: ${outputs.files.length} file${outputs.files.length === 1 ? "" : "s"} stored as artifacts${images.length ? ` (${images.length} image${images.length === 1 ? "" : "s"})` : ""}`];
  if (outputs.missing.length) parts.push(`matched nothing: ${outputs.missing.join(", ")}`);
  if (outputs.refused?.length) parts.push(`not stored: ${outputs.refused.map((refusal) => `${refusal.path} (${refusal.reason})`).join(", ")}`);
  let line = `${parts.join("; ")}.`;
  if (images.length) {
    line += !imageInput
      ? " This model cannot take image input, so the images were not shown; cite their artifact hashes."
      : shown.length
        ? ` Shown to you as image input: ${shown.join(", ")}${images.length > shown.length ? ` (at most ${MAX_TOOL_VISUALS_PER_REQUEST} per result)` : ""}.`
        : " The images could not be prepared as image input; cite their artifact hashes.";
  }
  return line;
}

function tighterLimits(requested: CaptureCommandOutputsInput["limits"]): OutputLimits {
  const bound = (key: "maxFiles" | "maxFileBytes" | "maxTotalBytes" | "maxScanEntries") => {
    const value = requested?.[key];
    return Number.isSafeInteger(value) && value! >= 0 ? Math.min(value!, COMMAND_OUTPUT_LIMITS[key]) : COMMAND_OUTPUT_LIMITS[key];
  };
  return { ...COMMAND_OUTPUT_LIMITS, maxFiles: bound("maxFiles"), maxFileBytes: bound("maxFileBytes"), maxTotalBytes: bound("maxTotalBytes"), maxScanEntries: bound("maxScanEntries") };
}

function isGlobSegment(segment: string): boolean {
  return /[*?[\]{}]/.test(segment);
}

/**
 * Expand one pattern segment by segment. Wildcards list real folders only (a link is never a
 * wildcard step) and skip .git and node_modules; a literal segment may pass through a link whose
 * canonical target stays inside the workspace, and one that leads out is reported as outside.
 */
async function expandPattern(
  root: string,
  segments: readonly string[],
  scan: { entries: number },
  maxScanEntries: number,
): Promise<{ candidates: string[]; outside: string[]; capped: boolean }> {
  const candidates = new Set<string>();
  const outside = new Set<string>();
  const stack: Array<{ parts: string[]; index: number }> = [{ parts: [], index: 0 }];
  const visited = new Set<string>();
  let capped = false;
  while (stack.length) {
    const { parts, index } = stack.pop()!;
    const key = `${parts.join("/")}\0${index}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (index === segments.length) { if (parts.length) candidates.add(parts.join("/")); continue; }
    const segment = segments[index]!;
    const last = index === segments.length - 1;
    if (!isGlobSegment(segment)) {
      const next = [...parts, segment];
      if (last) { candidates.add(next.join("/")); continue; }
      const step = await literalDirectory(root, next);
      if (step === "outside") outside.add(next.join("/"));
      else if (step === "directory") stack.push({ parts: next, index: index + 1 });
      continue;
    }
    const entries = await listDirectory(root, parts, scan, maxScanEntries);
    if (entries === "capped") { capped = true; break; }
    if (!entries) continue;
    if (segment === "**") {
      // `**` matches zero or more folders; as the last segment it matches every file below.
      if (!last) stack.push({ parts, index: index + 1 });
      for (const entry of entries) {
        if (entry.directory) {
          if (!WILDCARD_SKIPPED_DIRECTORIES.has(entry.name)) stack.push({ parts: [...parts, entry.name], index });
        } else if (last) candidates.add([...parts, entry.name].join("/"));
      }
      continue;
    }
    const matches = compileGlobs([segment], "outputs")!;
    for (const entry of entries) {
      if (!matches(entry.name)) continue;
      const next = [...parts, entry.name];
      if (last) candidates.add(next.join("/"));
      else if (entry.directory && !WILDCARD_SKIPPED_DIRECTORIES.has(entry.name)) stack.push({ parts: next, index: index + 1 });
    }
  }
  return { candidates: [...candidates].sort(), outside: [...outside].sort(), capped };
}

async function listDirectory(
  root: string,
  parts: readonly string[],
  scan: { entries: number },
  maxScanEntries: number,
): Promise<Array<{ name: string; directory: boolean }> | "capped" | undefined> {
  let entries;
  try { entries = await readdir(join(root, ...parts), { withFileTypes: true }); } catch { return undefined; }
  if (scan.entries + entries.length > maxScanEntries) return "capped";
  scan.entries += entries.length;
  // A Dirent reports a symlink or a junction as a link, never as a directory.
  return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
}

/** A literal intermediate segment: a real folder, a link to a folder inside the workspace, or neither. */
async function literalDirectory(root: string, parts: readonly string[]): Promise<"directory" | "outside" | "none"> {
  const path = join(root, ...parts);
  let details;
  try { details = await lstat(path); } catch { return "none"; }
  if (details.isDirectory()) return "directory";
  if (!details.isSymbolicLink()) return "none";
  const canonical = await canonicalInside(root, path);
  if (canonical === "outside") return "outside";
  if (!canonical) return "none";
  try { return (await lstat(canonical)).isDirectory() ? "directory" : "none"; } catch { return "none"; }
}

type CandidateOutcome =
  | { kind: "absent" }
  | { kind: "directory" }
  | { kind: "refused"; reason: CommandOutputRefusalReason; byteLength?: number }
  | { kind: "file"; canonical: string; size: number };

async function inspectCandidate(root: string, path: string, maxFileBytes: number, isHidden?: (absolutePath: string) => Promise<boolean>): Promise<CandidateOutcome> {
  const absolute = join(root, ...path.split("/"));
  try { await lstat(absolute); } catch { return { kind: "absent" }; }
  const canonical = await canonicalInside(root, absolute);
  if (canonical === "outside") return { kind: "refused", reason: "outside_workspace" };
  if (!canonical) return { kind: "absent" };
  if (isHidden && (await isHidden(absolute) || await isHidden(canonical))) return { kind: "refused", reason: "hidden" };
  let target;
  try { target = await lstat(canonical); } catch { return { kind: "absent" }; }
  if (target.isDirectory()) return { kind: "directory" };
  // Only regular files: a FIFO, socket or device could block or stream without end.
  if (!target.isFile()) return { kind: "refused", reason: "not_a_file" };
  if (target.size > maxFileBytes) return { kind: "refused", reason: "file_too_large", byteLength: target.size };
  return { kind: "file", canonical, size: target.size };
}

async function readContained(root: string, canonical: string, size: number): Promise<{ kind: "bytes"; bytes: Buffer } | { kind: "refused"; reason: CommandOutputRefusalReason }> {
  let bytes: Buffer;
  try { bytes = await readFile(canonical); } catch { return { kind: "refused", reason: "unreadable" }; }
  // Still the same regular file inside the workspace after the read, at the size that passed the caps.
  let details;
  try { details = await lstat(canonical); } catch { return { kind: "refused", reason: "changed_while_reading" }; }
  if (await canonicalInside(root, canonical) !== canonical || !details.isFile() || details.size !== size || bytes.byteLength !== size) {
    return { kind: "refused", reason: "changed_while_reading" };
  }
  return { kind: "bytes", bytes };
}

/**
 * The canonical path when it stays inside the canonical workspace, "outside" when a symlink or
 * junction leads out, undefined when it does not resolve. Canonical, as AGENTS.md requires for Runner
 * reads of project paths: realpath first, then the Runner's containment check (runnerOwnedPathContains),
 * because a lexical check alone passes a link to an outside file.
 */
async function canonicalInside(root: string, path: string): Promise<string | "outside" | undefined> {
  let canonical: string;
  try { canonical = await realpath(path); } catch { return undefined; }
  return runnerOwnedPathContains(root, canonical) ? canonical : "outside";
}

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".txt": "text/plain", ".log": "text/plain", ".out": "text/plain", ".md": "text/markdown",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json",
  ".xml": "application/xml", ".trx": "application/xml", ".html": "text/html", ".htm": "text/html",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".har": "application/json",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip",
};

/** Raster images by content, never by name; everything else by extension, else opaque bytes. */
function outputMediaType(bytes: Uint8Array, path: string): string {
  const detected = detectImageType(bytes);
  if (detected && detected !== "image/svg+xml") return detected;
  return MEDIA_TYPES_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream";
}
