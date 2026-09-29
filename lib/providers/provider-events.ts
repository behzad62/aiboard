import type { ToolCapabilityId } from "./tool-capabilities";

export interface CitationRef {
  url?: string;
  title?: string;
  sourceSpan?: unknown;
  providerData?: unknown;
}

export interface GeneratedArtifactRef {
  id: string;
  mimeType?: string;
  filename?: string;
  size?: number;
  storageRef: string;
}

export interface ProviderArtifactPayload {
  id?: string;
  bytes: Uint8Array | ArrayBuffer;
  mimeType?: string;
  filename?: string;
}

export interface ProviderArtifactSink {
  persist(payload: ProviderArtifactPayload): Promise<GeneratedArtifactRef>;
}

export interface ProviderToolEvent {
  id?: string;
  tool: ToolCapabilityId;
  phase: "started" | "progress" | "completed" | "failed";
  providerManaged: boolean;
  summary?: string;
  citations?: CitationRef[];
  artifacts?: GeneratedArtifactRef[];
  rawType?: string;
}

export interface ProviderToolEventInput extends Omit<ProviderToolEvent, "citations" | "artifacts"> {
  citations?: CitationRef[];
  artifacts?: GeneratedArtifactRef[];
  artifactPayloads?: ProviderArtifactPayload[];
}

function cloneCitation(citation: CitationRef): CitationRef {
  return {
    ...(citation.url !== undefined ? { url: citation.url } : {}),
    ...(citation.title !== undefined ? { title: citation.title } : {}),
    ...(citation.sourceSpan !== undefined ? { sourceSpan: citation.sourceSpan } : {}),
    ...(citation.providerData !== undefined ? { providerData: citation.providerData } : {}),
  };
}

export async function normalizeProviderToolEvent(
  input: ProviderToolEventInput,
  artifactSink?: ProviderArtifactSink,
): Promise<ProviderToolEvent> {
  if (input.artifactPayloads?.length && !artifactSink) {
    throw new Error("Provider-generated binary artifacts require an artifact sink.");
  }
  const persistedArtifacts = artifactSink
    ? await Promise.all((input.artifactPayloads ?? []).map((payload) => artifactSink.persist(payload)))
    : [];
  const artifacts = [...(input.artifacts ?? []), ...persistedArtifacts];
  return {
    ...(input.id !== undefined ? { id: input.id } : {}),
    tool: input.tool,
    phase: input.phase,
    providerManaged: input.providerManaged,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.citations?.length ? { citations: input.citations.map(cloneCitation) } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(input.rawType !== undefined ? { rawType: input.rawType } : {}),
  };
}
