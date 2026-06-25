import {
  estimateTokens,
  truncateToTokenBudget,
} from "./token-estimator";

export type ContextPackKind =
  | "source"
  | "summary"
  | "history"
  | "artifact"
  | "note"
  | "diagnostic"
  | "digest";

export type SelectedContextPackMode = "full" | "digest" | "truncated";

export interface ContextRetrieveRef {
  id: string;
  label?: string;
  kind?: string;
  tokenEstimate?: number;
  sourcePackId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ContextPack {
  id: string;
  title: string;
  kind: ContextPackKind;
  content: string;
  priority?: number;
  required?: boolean;
  exact?: boolean;
  sourcePath?: string;
  digest?: string;
  retrieveRef?: ContextRetrieveRef;
  createdAt?: string | number | Date;
  updatedAt?: string | number | Date;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SelectedContextPack extends ContextPack {
  includedContent: string;
  estimatedTokens: number;
  originalEstimatedTokens: number;
  score: number;
  mode: SelectedContextPackMode;
  order: number;
  truncated: boolean;
}

export type OmittedContextPackReason =
  | "budget-exceeded"
  | "empty"
  | "required-budget-exhausted";

export interface OmittedContextPack {
  id: string;
  title: string;
  kind: ContextPackKind;
  priority: number;
  required: boolean;
  exact: boolean;
  estimatedTokens: number;
  score: number;
  reason: OmittedContextPackReason;
  note: string;
}

export interface ContextPackAssembly {
  selected: SelectedContextPack[];
  omitted: OmittedContextPack[];
  tokenBudget: number;
  usedTokens: number;
  remainingTokens: number;
  notes: string[];
}

export interface AssembleContextPacksOptions {
  tokenBudget: number;
  allowDigestFallback?: boolean;
  requiredTruncationMarker?: string;
}

interface IndexedContextPack {
  pack: ContextPack;
  index: number;
}

interface PackSelection {
  includedContent: string;
  estimatedTokens: number;
  originalEstimatedTokens: number;
  mode: SelectedContextPackMode;
  truncated: boolean;
}

function normalizedPriority(pack: ContextPack): number {
  return typeof pack.priority === "number" && Number.isFinite(pack.priority)
    ? pack.priority
    : 0;
}

function timestamp(value: ContextPack["createdAt"]): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function recencyTimestamp(pack: ContextPack): number {
  return timestamp(pack.updatedAt) || timestamp(pack.createdAt);
}

function kindRank(pack: ContextPack): number {
  switch (pack.kind) {
    case "source":
      return 50;
    case "artifact":
      return 40;
    case "diagnostic":
      return 30;
    case "note":
      return 25;
    case "summary":
      return 20;
    case "digest":
      return 15;
    case "history":
      return 10;
  }
}

function isExactCurrentSource(pack: ContextPack): boolean {
  return pack.exact === true || (pack.kind === "source" && pack.exact !== false);
}

function comparePacks(a: IndexedContextPack, b: IndexedContextPack): number {
  const requiredDelta = Number(b.pack.required === true) - Number(a.pack.required === true);
  if (requiredDelta !== 0) return requiredDelta;

  const exactDelta =
    Number(isExactCurrentSource(b.pack)) - Number(isExactCurrentSource(a.pack));
  if (exactDelta !== 0) return exactDelta;

  const priorityDelta = normalizedPriority(b.pack) - normalizedPriority(a.pack);
  if (priorityDelta !== 0) return priorityDelta;

  const kindDelta = kindRank(b.pack) - kindRank(a.pack);
  if (kindDelta !== 0) return kindDelta;

  const recencyDelta = recencyTimestamp(b.pack) - recencyTimestamp(a.pack);
  if (recencyDelta !== 0) return recencyDelta;

  return a.index - b.index;
}

function retrieveRefLine(ref: ContextRetrieveRef | undefined): string {
  if (!ref) return "";
  const label = ref.label ? ` (${ref.label})` : "";
  const kind = ref.kind ? ` kind=${ref.kind}` : "";
  return `\n\nRetrieve ref: ${ref.id}${label}${kind}`;
}

function digestFallbackContent(pack: ContextPack): string | null {
  const digest = pack.digest?.trim();
  if (!digest) return null;
  return `${digest}${retrieveRefLine(pack.retrieveRef)}`;
}

function omittedPack(
  pack: ContextPack,
  reason: OmittedContextPackReason,
  estimatedTokens: number,
  note: string
): OmittedContextPack {
  return {
    id: pack.id,
    title: pack.title,
    kind: pack.kind,
    priority: normalizedPriority(pack),
    required: pack.required === true,
    exact: isExactCurrentSource(pack),
    estimatedTokens,
    score: scoreContextPack(pack),
    reason,
    note,
  };
}

function choosePackContent(
  pack: ContextPack,
  remainingTokens: number,
  options: Required<Pick<AssembleContextPacksOptions, "allowDigestFallback">> &
    Pick<AssembleContextPacksOptions, "requiredTruncationMarker">
): PackSelection | null {
  const originalEstimatedTokens = estimateTokens(pack.content);

  if (pack.content.trim().length === 0) {
    return null;
  }

  if (originalEstimatedTokens <= remainingTokens) {
    return {
      includedContent: pack.content,
      estimatedTokens: originalEstimatedTokens,
      originalEstimatedTokens,
      mode: "full",
      truncated: false,
    };
  }

  if (options.allowDigestFallback && !isExactCurrentSource(pack)) {
    const digestContent = digestFallbackContent(pack);
    if (digestContent) {
      const digestTokens = estimateTokens(digestContent);
      if (digestTokens <= remainingTokens) {
        return {
          includedContent: digestContent,
          estimatedTokens: digestTokens,
          originalEstimatedTokens,
          mode: "digest",
          truncated: false,
        };
      }
    }
  }

  if (pack.required === true && remainingTokens > 0) {
    const truncated = truncateToTokenBudget(pack.content, remainingTokens, {
      marker: options.requiredTruncationMarker,
      preserveEndTokens: Math.min(120, Math.floor(remainingTokens * 0.2)),
    });
    if (truncated.estimatedTokens > 0) {
      return {
        includedContent: truncated.text,
        estimatedTokens: truncated.estimatedTokens,
        originalEstimatedTokens,
        mode: "truncated",
        truncated: true,
      };
    }
  }

  return null;
}

export function scoreContextPack(pack: ContextPack): number {
  const requiredScore = pack.required ? 1_000_000 : 0;
  const exactScore = isExactCurrentSource(pack) ? 100_000 : 0;
  const priorityScore = normalizedPriority(pack) * 1_000;
  const kindScore = kindRank(pack) * 10;
  const recencyScore = Math.min(
    999,
    Math.max(0, Math.floor(recencyTimestamp(pack) / 10_000_000_000))
  );

  return requiredScore + exactScore + priorityScore + kindScore + recencyScore;
}

export function assembleContextPacks(
  packs: ContextPack[],
  options: AssembleContextPacksOptions
): ContextPackAssembly {
  const tokenBudget = Math.max(0, Math.floor(options.tokenBudget));
  const selectionOptions = {
    allowDigestFallback: options.allowDigestFallback ?? true,
    requiredTruncationMarker:
      options.requiredTruncationMarker ?? "\n...[required context truncated]\n",
  };
  const sortedPacks = packs
    .map((pack, index) => ({ pack, index }))
    .sort(comparePacks);
  const selected: SelectedContextPack[] = [];
  const omitted: OmittedContextPack[] = [];
  const notes: string[] = [];
  let usedTokens = 0;

  for (const { pack } of sortedPacks) {
    const remainingTokens = Math.max(0, tokenBudget - usedTokens);
    const originalEstimatedTokens = estimateTokens(pack.content);

    if (pack.content.trim().length === 0) {
      omitted.push(
        omittedPack(pack, "empty", originalEstimatedTokens, "Context pack is empty.")
      );
      continue;
    }

    if (remainingTokens <= 0) {
      omitted.push(
        omittedPack(
          pack,
          pack.required ? "required-budget-exhausted" : "budget-exceeded",
          originalEstimatedTokens,
          "No context-pack budget remained."
        )
      );
      continue;
    }

    const selection = choosePackContent(pack, remainingTokens, selectionOptions);
    if (!selection) {
      omitted.push(
        omittedPack(
          pack,
          "budget-exceeded",
          originalEstimatedTokens,
          "Context pack did not fit in the remaining token budget."
        )
      );
      continue;
    }

    selected.push({
      ...pack,
      includedContent: selection.includedContent,
      estimatedTokens: selection.estimatedTokens,
      originalEstimatedTokens: selection.originalEstimatedTokens,
      score: scoreContextPack(pack),
      mode: selection.mode,
      order: selected.length,
      truncated: selection.truncated,
    });
    usedTokens += selection.estimatedTokens;

    if (selection.mode === "digest") {
      notes.push(`Used digest fallback for ${pack.title}.`);
    } else if (selection.mode === "truncated") {
      notes.push(`Truncated required context pack ${pack.title}.`);
    }
  }

  return {
    selected,
    omitted,
    tokenBudget,
    usedTokens,
    remainingTokens: Math.max(0, tokenBudget - usedTokens),
    notes,
  };
}
