import {
  assembleContextPacks,
  type AssembleContextPacksOptions,
  type ContextPack,
  type ContextPackAssembly,
  type OmittedContextPack,
  type SelectedContextPack,
} from "./context-packs";

export interface RenderContextPackSectionOptions {
  heading?: string;
  includeOmissionNotes?: boolean;
}

export interface RenderedContextPackSection {
  text: string;
  tokenTotal: number;
  tokenBudget: number;
  remainingTokens: number;
  packCount: number;
  omittedCount: number;
  omissionNotes: string[];
  assembly: ContextPackAssembly;
}

export interface AssembleContextPackPromptOptions
  extends AssembleContextPacksOptions,
    RenderContextPackSectionOptions {}

function renderSelectedPack(pack: SelectedContextPack): string {
  const sourcePath = pack.sourcePath ? ` path=${pack.sourcePath}` : "";
  const retrieveRef = pack.retrieveRef
    ? `\nRetrieve ref: ${pack.retrieveRef.id}`
    : "";
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
  const omissionNotes = assembly.omitted.map(omissionNote);
  const parts = [
    `## ${heading}`,
    `Context tokens: ${assembly.usedTokens}/${assembly.tokenBudget}`,
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

  return {
    text: parts.join("\n\n"),
    tokenTotal: assembly.usedTokens,
    tokenBudget: assembly.tokenBudget,
    remainingTokens: assembly.remainingTokens,
    packCount: assembly.selected.length,
    omittedCount: assembly.omitted.length,
    omissionNotes,
    assembly,
  };
}

export function assembleContextPackPrompt(
  packs: ContextPack[],
  options: AssembleContextPackPromptOptions
): RenderedContextPackSection {
  const assembly = assembleContextPacks(packs, options);
  return renderContextPackSection(assembly, options);
}
