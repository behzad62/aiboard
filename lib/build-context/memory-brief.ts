import {
  compactOneLine,
  isActiveBuildMemory,
  normalizeMemoryPath,
  type BuildMemoryKind,
  type BuildMemoryRecord,
} from "./memory-store";
import {
  estimateTokens,
  truncateToTokenBudget,
} from "./token-estimator";

export interface BuildMemoryRankingOptions {
  audience: "architect" | "worker";
  taskId?: string;
  paths?: string[];
}

export interface BuildMemoryBriefOptions {
  tokenBudget?: number;
}

export interface BuildMemoryBrief {
  text: string;
  records: BuildMemoryRecord[];
  truncated: boolean;
  tokenEstimate: number;
}

const KIND_LABELS: Record<BuildMemoryKind, string> = {
  user_correction: "User correction",
  decision: "Decision",
  failed_approach: "Failed approach",
  fragile_file: "Fragile file",
  skill_violation: "Skill violation",
  reliable_command: "Reliable command",
};

const ARCHITECT_KIND_WEIGHT: Record<BuildMemoryKind, number> = {
  user_correction: 100,
  decision: 90,
  failed_approach: 75,
  reliable_command: 65,
  skill_violation: 60,
  fragile_file: 55,
};

const WORKER_KIND_WEIGHT: Record<BuildMemoryKind, number> = {
  user_correction: 100,
  failed_approach: 95,
  fragile_file: 90,
  skill_violation: 80,
  decision: 70,
  reliable_command: 55,
};

function pathKey(path: string): string {
  return normalizeMemoryPath(path).toLowerCase().replace(/\/+$/, "");
}

export function isMemoryRelevantToPaths(
  record: Pick<BuildMemoryRecord, "paths">,
  paths: string[] = []
): boolean {
  const recordPaths = (record.paths ?? []).map(pathKey).filter(Boolean);
  if (recordPaths.length === 0 || paths.length === 0) return false;
  const targetPaths = paths.map(pathKey).filter(Boolean);
  return recordPaths.some((recordPath) =>
    targetPaths.some(
      (targetPath) =>
        targetPath === recordPath ||
        targetPath.startsWith(`${recordPath}/`) ||
        recordPath.startsWith(`${targetPath}/`)
    )
  );
}

function scoreMemory(record: BuildMemoryRecord, options: BuildMemoryRankingOptions): number {
  const weights =
    options.audience === "architect" ? ARCHITECT_KIND_WEIGHT : WORKER_KIND_WEIGHT;
  let score = weights[record.kind];
  if (options.taskId && (record.taskIds ?? []).includes(options.taskId)) score += 80;
  if (isMemoryRelevantToPaths(record, options.paths ?? [])) score += 70;
  score += Math.min(25, Math.max(0, record.hitCount - 1) * 5);
  score += Math.min(15, record.evidence.length * 2);
  return score;
}

export function rankBuildMemories(
  records: BuildMemoryRecord[],
  options: BuildMemoryRankingOptions
): BuildMemoryRecord[] {
  return records
    .filter(isActiveBuildMemory)
    .filter((record) => {
      if (options.audience === "architect") return true;
      if (record.kind === "decision" || record.kind === "user_correction") return true;
      if (record.kind === "reliable_command") return true;
      if (options.taskId && (record.taskIds ?? []).includes(options.taskId)) return true;
      return isMemoryRelevantToPaths(record, options.paths ?? []);
    })
    .sort((a, b) => {
      const diff = scoreMemory(b, options) - scoreMemory(a, options);
      if (diff !== 0) return diff;
      return b.lastSeenAt.localeCompare(a.lastSeenAt);
    });
}

function renderEvidence(record: BuildMemoryRecord): string {
  const refs = record.evidence
    .slice(0, 2)
    .map((evidence) => `${evidence.kind}:${evidence.ref}`)
    .join(", ");
  return refs ? ` Evidence: ${refs}.` : "";
}

function renderRecord(record: BuildMemoryRecord): string {
  const scope = [
    record.paths?.length ? `paths: ${record.paths.slice(0, 4).join(", ")}` : "",
    record.taskIds?.length ? `tasks: ${record.taskIds.slice(0, 4).join(", ")}` : "",
    record.command ? `command: ${record.command}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return `- ${KIND_LABELS[record.kind]}: ${compactOneLine(record.summary, 220)}${
    scope ? ` (${scope})` : ""
  }.${renderEvidence(record)}`;
}

function buildBrief(
  records: BuildMemoryRecord[],
  ranking: BuildMemoryRankingOptions,
  options: BuildMemoryBriefOptions = {}
): BuildMemoryBrief {
  const tokenBudget = Math.max(0, Math.floor(options.tokenBudget ?? 700));
  const ranked = rankBuildMemories(records, ranking);
  if (ranked.length === 0 || tokenBudget <= 0) {
    return { text: "", records: [], truncated: false, tokenEstimate: 0 };
  }

  const selected: BuildMemoryRecord[] = [];
  const lines = ["Build memory (evidence-backed; do not repeat known mistakes):"];
  let truncated = false;
  for (const record of ranked) {
    const nextLines = [...lines, renderRecord(record)];
    if (estimateTokens(nextLines.join("\n")) > tokenBudget) {
      truncated = true;
      break;
    }
    selected.push(record);
    lines.push(renderRecord(record));
  }

  if (selected.length === 0) {
    const first = truncateToTokenBudget(
      ["Build memory (evidence-backed; do not repeat known mistakes):", renderRecord(ranked[0])].join("\n"),
      tokenBudget,
      { marker: "\n[memory truncated]\n" }
    );
    return {
      text: first.text,
      records: [ranked[0]],
      truncated: true,
      tokenEstimate: first.estimatedTokens,
    };
  }

  if (truncated) {
    lines.push(`[memory truncated] ${ranked.length - selected.length} more record(s) omitted.`);
  }

  let text = lines.join("\n");
  const limited = truncateToTokenBudget(text, tokenBudget, {
    marker: "\n[memory truncated]\n",
  });
  text = limited.text;
  return {
    text,
    records: selected,
    truncated: truncated || limited.truncated,
    tokenEstimate: limited.estimatedTokens,
  };
}

export function buildArchitectMemoryBrief(
  records: BuildMemoryRecord[],
  options: BuildMemoryBriefOptions = {}
): BuildMemoryBrief {
  return buildBrief(records, { audience: "architect" }, options);
}

export function buildWorkerMemoryBrief(
  records: BuildMemoryRecord[],
  options: BuildMemoryBriefOptions & { taskId?: string; paths?: string[] } = {}
): BuildMemoryBrief {
  return buildBrief(
    records,
    { audience: "worker", taskId: options.taskId, paths: options.paths },
    options
  );
}
