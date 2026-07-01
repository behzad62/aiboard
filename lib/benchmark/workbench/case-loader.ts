import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import type {
  WorkBenchBudget,
  WorkBenchCase,
  WorkBenchContamination,
  WorkBenchDifficulty,
  WorkBenchEnvironment,
  WorkBenchNetwork,
  WorkBenchPrompt,
  WorkBenchRepo,
  WorkBenchScoring,
  WorkBenchVerifier,
} from "./types";

const DIFFICULTIES = new Set<WorkBenchDifficulty>([
  "easy",
  "medium",
  "hard",
  "expert",
]);
const NETWORKS = new Set<WorkBenchNetwork>(["none", "dependency-only"]);

export function loadWorkBenchCaseFromJson(json: string): WorkBenchCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid WorkBench case JSON: ${message}`);
  }
  return loadWorkBenchCase(parsed);
}

export function loadWorkBenchCase(manifest: unknown): WorkBenchCase {
  if (!isRecord(manifest) || Array.isArray(manifest)) {
    throw new Error("WorkBench case manifest must be an object.");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("WorkBench case manifest schemaVersion must be 1.");
  }

  const id = requiredString(manifest, "id", "manifest");
  const title = requiredString(manifest, "title", "manifest");
  const description = requiredString(manifest, "description", "manifest");
  const difficulty = enumString(
    optionalString(manifest, "difficulty") ?? "medium",
    DIFFICULTIES,
    "difficulty"
  );
  const tags = stringArray(manifest.tags, "tags");
  const caseVersion = optionalString(manifest, "caseVersion") ?? "0.1.0";
  const prompt = parsePrompt(requiredRecord(manifest, "prompt"));
  const repo = parseRepo(requiredRecord(manifest, "repo"));
  const environment = parseEnvironment(requiredRecord(manifest, "environment"));
  const verifier = parseVerifier(requiredRecord(manifest, "verifier"));
  const budget = parseBudget(optionalRecord(manifest, "budget"));
  const scoring = parseScoring(optionalRecord(manifest, "scoring"));
  const contamination = parseContamination(requiredRecord(manifest, "contamination"));
  const explicitAllowed = stringArray(manifest.allowedCommands, "allowedCommands", true);
  const allowedCommands = uniqueStrings([
    environment.setupCommand,
    verifier.command,
    ...explicitAllowed,
  ]);
  if (environment.network === "none" && allowedCommands.length > 0) {
    throw new Error(
      "WorkBench cannot enforce network none while executing setup, verifier, or allowed commands; use dependency-only."
    );
  }

  return {
    schemaVersion: 1,
    id,
    title,
    description,
    difficulty,
    tags,
    caseVersion,
    prompt,
    repo,
    environment,
    verifier,
    budget,
    scoring,
    contamination,
    allowedCommands,
  };
}

export function toBenchmarkCaseV2(
  workBenchCase: WorkBenchCase,
  timestamp = new Date().toISOString()
): BenchmarkCaseV2 {
  return {
    id: workBenchCase.id,
    schemaVersion: 2,
    track: "workbench",
    title: workBenchCase.title,
    description: workBenchCase.description,
    difficulty: workBenchCase.difficulty,
    tags: workBenchCase.tags,
    caseVersion: workBenchCase.caseVersion,
    createdAt: timestamp,
    updatedAt: timestamp,
    prompt: { ...workBenchCase.prompt },
    repo: { ...workBenchCase.repo },
    environment: {
      type: "local-runner",
      setupCommand: workBenchCase.environment.setupCommand,
      timeoutSeconds: workBenchCase.environment.timeoutSeconds,
      memoryMb: workBenchCase.environment.memoryMb,
      network: workBenchCase.environment.network,
    },
    verifier: {
      command: workBenchCase.verifier.command,
      resultFile: workBenchCase.verifier.resultFile,
      publicCommand: workBenchCase.verifier.publicCommand,
      hiddenCommandHash: workBenchCase.verifier.hiddenCommandHash,
      timeoutSeconds: workBenchCase.verifier.timeoutSeconds,
      scorer: "verifier-json",
    },
    budget: { ...workBenchCase.budget },
    scoring: {
      scoringVersion: workBenchCase.scoring.scoringVersion,
      primary: "verified_quality",
      costTargetUsd: workBenchCase.scoring.costTargetUsd,
      timeTargetSeconds: workBenchCase.scoring.timeTargetSeconds,
    },
    contamination: { ...workBenchCase.contamination },
  };
}

export function createWorkBenchCaseHash(workBenchCase: WorkBenchCase): string {
  return `workbench:${fnv1aHex(stableJson(workBenchCase))}`;
}

function parsePrompt(record: Record<string, unknown>): WorkBenchPrompt {
  return {
    userRequest: requiredString(record, "userRequest", "prompt"),
    publicContext: optionalString(record, "publicContext"),
    hiddenNotesHash: optionalString(record, "hiddenNotesHash"),
    systemPromptHash: optionalString(record, "systemPromptHash"),
    attachmentIds: stringArray(record.attachmentIds, "prompt.attachmentIds", true),
  };
}

function parseRepo(record: Record<string, unknown>): WorkBenchRepo {
  return {
    url: requiredString(record, "url", "repo"),
    baseCommit: requiredString(record, "baseCommit", "repo"),
    shallowClone:
      typeof record.shallowClone === "boolean" ? record.shallowClone : true,
    fixtureHash: optionalString(record, "fixtureHash"),
  };
}

function parseEnvironment(record: Record<string, unknown>): WorkBenchEnvironment {
  const network = enumString(
    optionalString(record, "network") ?? "none",
    NETWORKS,
    "network"
  );
  if (record.memoryMb !== undefined && record.memoryMb !== null) {
    throw new Error(
      "WorkBench v0.1 local runner cannot enforce environment.memoryMb; omit it instead of implying a memory boundary."
    );
  }
  return {
    type: "local-runner",
    setupCommand: optionalString(record, "setupCommand"),
    timeoutSeconds: positiveNumber(record.timeoutSeconds, "environment.timeoutSeconds"),
    network,
  };
}

function parseVerifier(record: Record<string, unknown>): WorkBenchVerifier {
  const command = requiredString(record, "command", "verifier");
  const resultFile = optionalString(record, "resultFile");
  if (resultFile) assertSafeRelativePath(resultFile, "verifier.resultFile");
  return {
    command,
    resultFile,
    publicCommand: optionalString(record, "publicCommand"),
    hiddenCommandHash: optionalString(record, "hiddenCommandHash"),
    timeoutSeconds:
      record.timeoutSeconds === undefined
        ? undefined
        : positiveNumber(record.timeoutSeconds, "verifier.timeoutSeconds"),
  };
}

function parseBudget(record: Record<string, unknown> | null): WorkBenchBudget {
  if (!record) return {};
  return {
    maxUsd: optionalPositiveNumber(record, "maxUsd", "budget"),
    maxWallClockSeconds: optionalPositiveNumber(record, "maxWallClockSeconds", "budget"),
    maxModelCalls: optionalPositiveNumber(record, "maxModelCalls", "budget"),
    maxToolCalls: optionalPositiveNumber(record, "maxToolCalls", "budget"),
    maxInputTokens: optionalPositiveNumber(record, "maxInputTokens", "budget"),
    maxOutputTokens: optionalPositiveNumber(record, "maxOutputTokens", "budget"),
  };
}

function parseScoring(record: Record<string, unknown> | null): WorkBenchScoring {
  if (!record) return { scoringVersion: "certified-v0.1" };
  return {
    scoringVersion: optionalString(record, "scoringVersion") ?? "certified-v0.1",
    costTargetUsd: optionalPositiveNumber(record, "costTargetUsd", "scoring"),
    timeTargetSeconds: optionalPositiveNumber(record, "timeTargetSeconds", "scoring"),
  };
}

function parseContamination(record: Record<string, unknown>): WorkBenchContamination {
  if (typeof record.originalTask !== "boolean") {
    throw new Error("contamination.originalTask must be a boolean.");
  }
  if (typeof record.referenceSolutionPrivate !== "boolean") {
    throw new Error("contamination.referenceSolutionPrivate must be a boolean.");
  }
  return {
    originalTask: record.originalTask,
    canary: requiredString(record, "canary", "contamination"),
    referenceSolutionPrivate: record.referenceSolutionPrivate,
    publicAfter: optionalString(record, "publicAfter"),
  };
}

function assertSafeRelativePath(path: string, label: string): void {
  const normalized = path.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string when provided.`);
  }
  return value.trim() || undefined;
}

function requiredRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`${key} must be an object.`);
  return value;
}

function optionalRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`${key} must be an object.`);
  return value;
}

function stringArray(value: unknown, label: string, optional = false): string[] {
  if (value === undefined || value === null) {
    if (optional) return [];
    throw new Error(`${label} must be an array.`);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function optionalPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  label: string
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  return positiveNumber(value, `${label}.${key}`);
}

function enumString<T extends string>(value: string, allowed: Set<T>, label: string): T {
  if (!allowed.has(value as T)) {
    throw new Error(`${label} must be one of: ${Array.from(allowed).join(", ")}.`);
  }
  return value as T;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      values.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    )
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
