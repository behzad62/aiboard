import { createHash } from "node:crypto";
import type { AssignmentClaim } from "./planning-contracts.js";
import { claimPathContains } from "./task-resource-claims.js";
import { isSensitiveKey } from "./sensitive-redaction.js";

export interface SubmissionFile {
  path: string;
  added: boolean;
  addedLines: readonly string[];
}
export interface SubmissionScopeFinding {
  id: string;
  code: "outside_claim" | "forbidden_surface" | "instruction_surface" | "harness_diary";
  path: string;
  severity: "blocking";
  message: string;
}

/**
 * Refusal never carries the matching value, line content, or a sensitive filename. It names an
 * ordinary file and the field the value was assigned to, so the worker can fix it: the bare refusal
 * left a worker resubmitting until its turn budget ran out (tunnel run).
 */
export function assertSubmissionHasNoSecrets(files: readonly SubmissionFile[]): void {
  for (const file of files) {
    const path = submissionPath(file.path);
    if (file.added && secretFilePath(path)) {
      throw new Error("Submission refused: secret or key material detected [REDACTED].");
    }
    for (const line of file.addedLines) {
      const hit = secretLine(line);
      if (hit === false) continue;
      throw new Error(
        `Submission refused: secret or key material detected [REDACTED] in ${path}` +
        `${hit === true ? "" : ` (value assigned to ${hit})`}. Use an obviously fake placeholder or build test values at runtime.`,
      );
    }
  }
}

function secretFilePath(path: string): boolean {
  const name = path.split("/").at(-1)!.toLowerCase();
  return name === ".env" || name.startsWith(".env.") || /\.(?:pem|p12|pfx|key)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name);
}

/** False when clean; true for a token-pattern match; the field name for a sensitive assignment. */
function secretLine(line: string): boolean | string {
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(line) ||
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(line) ||
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/.test(line) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(line)) return true;
  for (const match of line.matchAll(/["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[:=]\s*(?:(["'`])([^"'`\r\n]{16,})\2|([A-Za-z0-9_./+=:@%-]{16,}))/g)) {
    const value = match[3] ?? match[4]!;
    const environmentReference = match[2] === undefined && /^(?:process\.env\.|os\.environ\.|env\.)[A-Za-z_][A-Za-z0-9_]*$/.test(value);
    const templateReference = match[2] === "`" && /^\$\{[A-Za-z_][A-Za-z0-9_.$]*\}$/.test(value);
    const wholePlaceholder = /^\{\{\s*[A-Za-z_][A-Za-z0-9_.]*\s*\}\}$/.test(value);
    // Code, not a literal: a call (generateDeviceToken()), a member reference (config.adminToken), a
    // template that is mostly interpolation (`Bearer ${token}`), or an angle-bracket placeholder.
    const end = (match.index ?? 0) + match[0].length;
    const callExpression = match[2] === undefined && /^\s*\(/.test(line.slice(end));
    const memberReference = match[2] === undefined && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
    const interpolatedTemplate = match[2] === "`" && value.includes("${") && value.replace(/\$\{[^}]*\}/g, "").length < 16;
    const anglePlaceholder = /<[A-Za-z][\w-]*>/.test(value);
    if (
      isSensitiveKey(match[1]!) && !environmentReference && !templateReference && !wholePlaceholder &&
      !callExpression && !memberReference && !interpolatedTemplate && !anglePlaceholder
    ) return match[1]!;
  }
  return false;
}

/** Mechanical scope facts only; the Architect owns their disposition. */
export function inspectSubmissionScope(files: readonly SubmissionFile[], claim: Pick<AssignmentClaim, "writableSurfaces" | "forbiddenSurfaces">): SubmissionScopeFinding[] {
  const findings: SubmissionScopeFinding[] = [];
  for (const file of files) {
    const path = submissionPath(file.path);
    const claimed = claim.writableSurfaces.some((surface) => !surface.startsWith("resource:") && claimPathContains(surface, path));
    const codes: SubmissionScopeFinding["code"][] = [];
    if (!claimed) codes.push("outside_claim");
    if (claim.forbiddenSurfaces.some((surface) => claimPathContains(surface, path))) codes.push("forbidden_surface");
    if (!claimed && /(?:^|\/)(?:agents\.md|claude\.md|\.github(?:\/|$)|\.git[^/]*)/i.test(path)) codes.push("instruction_surface");
    if (file.added && diaryPath(path)) codes.push("harness_diary");
    for (const code of codes) findings.push({
      id: `scope:${createHash("sha256").update(`${code}\0${path}`).digest("hex")}`,
      code, path, severity: "blocking", message: `${code}: submission path requires an explicit Architect scope resolution.`,
    });
  }
  return findings;
}

function submissionPath(input: string): string {
  const path = input.replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Submission path identity is invalid.");
  }
  return path;
}

function diaryPath(path: string): boolean {
  return /(?:^|\/)(?:progress|evidence|reviews?|test[-_]?outputs?)(?:[._-]|\/|$)/i.test(path);
}
