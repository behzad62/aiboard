import {
  assembleContextPacks,
  type AssembleContextPacksOptions,
  type ContextRetrieveRef,
  type ContextPack,
  type ContextPackAssembly,
  type OmittedContextPack,
  type SelectedContextPack,
} from "./context-packs";
import {
  estimateTokens,
  truncateToTokenBudget,
} from "./token-estimator";

export interface RenderContextPackSectionOptions {
  heading?: string;
  includeOmissionNotes?: boolean;
  renderedTokenBudget?: number;
}

export interface RenderedContextPackSection {
  text: string;
  tokenTotal: number;
  renderedTokenTotal: number;
  contentTokenTotal: number;
  tokenBudget: number;
  remainingTokens: number;
  contentRemainingTokens: number;
  renderedOverBudget: boolean;
  renderedTruncated: boolean;
  packCount: number;
  omittedCount: number;
  omissionNotes: string[];
  assembly: ContextPackAssembly;
}

export interface AssembleContextPackPromptOptions
  extends AssembleContextPacksOptions,
    RenderContextPackSectionOptions {}

function renderRetrieveRef(ref: ContextRetrieveRef | undefined): string {
  if (!ref) return "";
  const label = ref.label ? ` (${ref.label})` : "";
  const kind = ref.kind ? ` kind=${ref.kind}` : "";
  return `\nRetrieve ref: ${ref.id}${label}${kind}`;
}

function renderSelectedPack(pack: SelectedContextPack): string {
  const sourcePath = pack.sourcePath ? ` path=${pack.sourcePath}` : "";
  const retrieveRef = renderRetrieveRef(pack.retrieveRef);
  const mode = pack.mode === "full" ? "" : ` mode=${pack.mode}`;

  return [
    `### ${pack.title}`,
    `id=${pack.id} kind=${pack.kind}${sourcePath}${mode} tokens=${pack.estimatedTokens}`,
    retrieveRef,
    pack.includedContent,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function omissionNote(pack: OmittedContextPack): string {
  return `${pack.title} (${pack.id}) omitted: ${pack.reason}, approx ${pack.estimatedTokens} tokens. ${pack.note}`;
}

export function renderContextPackSection(
  assembly: ContextPackAssembly,
  options: RenderContextPackSectionOptions = {}
): RenderedContextPackSection {
  const heading = options.heading ?? "Build context";
  const tokenBudget = Math.max(
    0,
    Math.floor(options.renderedTokenBudget ?? assembly.tokenBudget)
  );
  const omissionNotes = assembly.omitted.map(omissionNote);
  const parts = [
    `## ${heading}`,
    `Context content tokens: ${assembly.usedTokens}/${assembly.tokenBudget}`,
  ];

  if (assembly.selected.length === 0) {
    parts.push("No context packs selected.");
  } else {
    parts.push(...assembly.selected.map(renderSelectedPack));
  }

  if (options.includeOmissionNotes && omissionNotes.length > 0) {
    parts.push(
      "### Omitted context",
      ...omissionNotes.map((note) => `- ${note}`)
    );
  }
  const text = parts.join("\n\n");
  const renderedTokenTotal = estimateTokens(text);
  const remainingTokens = Math.max(0, tokenBudget - renderedTokenTotal);

  return {
    text,
    tokenTotal: renderedTokenTotal,
    renderedTokenTotal,
    contentTokenTotal: assembly.usedTokens,
    tokenBudget,
    remainingTokens,
    contentRemainingTokens: assembly.remainingTokens,
    renderedOverBudget: renderedTokenTotal > tokenBudget,
    renderedTruncated: false,
    packCount: assembly.selected.length,
    omittedCount: assembly.omitted.length,
    omissionNotes,
    assembly,
  };
}

function renderWithContentBudget(
  packs: ContextPack[],
  contentTokenBudget: number,
  renderedTokenBudget: number,
  options: AssembleContextPackPromptOptions
): RenderedContextPackSection {
  const assembly = assembleContextPacks(packs, {
    tokenBudget: contentTokenBudget,
    allowDigestFallback: options.allowDigestFallback,
    requiredTruncationMarker: options.requiredTruncationMarker,
  });
  return renderContextPackSection(assembly, {
    heading: options.heading,
    includeOmissionNotes: options.includeOmissionNotes,
    renderedTokenBudget,
  });
}

function clampRenderedSectionToBudget(
  section: RenderedContextPackSection,
  tokenBudget: number
): RenderedContextPackSection {
  if (section.renderedTokenTotal <= tokenBudget) return section;

  const truncated = truncateToTokenBudget(section.text, tokenBudget);
  return {
    ...section,
    text: truncated.text,
    tokenTotal: truncated.estimatedTokens,
    renderedTokenTotal: truncated.estimatedTokens,
    remainingTokens: Math.max(0, tokenBudget - truncated.estimatedTokens),
    renderedOverBudget: false,
    renderedTruncated: true,
  };
}

function findRenderedBudgetFit(
  packs: ContextPack[],
  renderedTokenBudget: number,
  options: AssembleContextPackPromptOptions
): RenderedContextPackSection {
  let low = 0;
  let high = renderedTokenBudget;
  let best = renderWithContentBudget(packs, 0, renderedTokenBudget, options);

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = renderWithContentBudget(
      packs,
      midpoint,
      renderedTokenBudget,
      options
    );

    if (candidate.renderedTokenTotal <= renderedTokenBudget) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return clampRenderedSectionToBudget(best, renderedTokenBudget);
}

export function assembleContextPackPrompt(
  packs: ContextPack[],
  options: AssembleContextPackPromptOptions
): RenderedContextPackSection {
  const renderedTokenBudget = Math.max(0, Math.floor(options.tokenBudget));
  const withRequestedNotes = findRenderedBudgetFit(
    packs,
    renderedTokenBudget,
    options
  );

  if (
    !withRequestedNotes.renderedTruncated ||
    options.includeOmissionNotes !== true
  ) {
    return withRequestedNotes;
  }

  return findRenderedBudgetFit(packs, renderedTokenBudget, {
    ...options,
    includeOmissionNotes: false,
  });
}
