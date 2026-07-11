import { createHash } from "node:crypto";

export interface ContextLimits {
  maxBytes: number;
  maxEstimatedTokens: number;
}

export interface ContextSection {
  id: string;
  kind: string;
  required: boolean;
  priority: number;
  content: string;
  sourceDigest?: string;
  artifactHash?: string;
}

export interface IncludedContextSection {
  id: string;
  kind: string;
  required: boolean;
  priority: number;
  byteLength: number;
  digest: string;
}

export interface ContextOmission {
  id: string;
  kind: string;
  reason: "byte_budget" | "token_budget";
  byteLength: number;
  digest: string;
  artifactHash?: string;
}

export interface ContextPack {
  text: string;
  sections: IncludedContextSection[];
  omissions: ContextOmission[];
  byteLength: number;
  estimatedTokens: number;
  digest: string;
}

export class ProtectedContextOverflowError extends Error {
  constructor(
    readonly requiredSectionIds: string[],
    readonly requiredBytes: number,
    readonly limitBytes: number
  ) {
    super(
      `Protected context (${requiredBytes} bytes) exceeds the effective limit (${limitBytes} bytes).`
    );
    this.name = "ProtectedContextOverflowError";
  }
}

export class ContextAssembler {
  private readonly limits: ContextLimits;
  private readonly effectiveByteLimit: number;

  constructor(limits: ContextLimits) {
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) {
      throw new Error("maxBytes must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(limits.maxEstimatedTokens) ||
      limits.maxEstimatedTokens < 1
    ) {
      throw new Error("maxEstimatedTokens must be a positive integer.");
    }
    this.limits = { ...limits };
    this.effectiveByteLimit = Math.min(
      limits.maxBytes,
      limits.maxEstimatedTokens * 4
    );
  }

  assemble(input: readonly ContextSection[]): ContextPack {
    assertSections(input);
    const indexed = input.map((section, index) => ({ section, index }));
    const required = indexed.filter((item) => item.section.required);
    const optional = indexed
      .filter((item) => !item.section.required)
      .sort(
        (left, right) =>
          right.section.priority - left.section.priority ||
          left.index - right.index ||
          left.section.id.localeCompare(right.section.id)
      );
    const renderedRequired = required.map((item) => render(item.section));
    const requiredBytes = joinedLength(renderedRequired);
    if (requiredBytes > this.effectiveByteLimit) {
      throw new ProtectedContextOverflowError(
        required.map((item) => item.section.id),
        requiredBytes,
        this.effectiveByteLimit
      );
    }

    const included = [...required];
    const rendered = [...renderedRequired];
    const omissions: ContextOmission[] = [];
    let byteLength = requiredBytes;
    for (const item of optional) {
      const value = render(item.section);
      const separatorBytes = rendered.length > 0 ? 2 : 0;
      const nextBytes = byteLength + separatorBytes + Buffer.byteLength(value);
      if (nextBytes <= this.effectiveByteLimit) {
        included.push(item);
        rendered.push(value);
        byteLength = nextBytes;
      } else {
        const byteBudgetIsTighter = this.limits.maxBytes <= this.limits.maxEstimatedTokens * 4;
        omissions.push({
          id: item.section.id,
          kind: item.section.kind,
          reason: byteBudgetIsTighter ? "byte_budget" : "token_budget",
          byteLength: Buffer.byteLength(value),
          digest: digest(item.section.content),
          ...(item.section.artifactHash
            ? { artifactHash: item.section.artifactHash }
            : {}),
        });
      }
    }
    const text = rendered.join("\n\n");
    const actualBytes = Buffer.byteLength(text);
    return {
      text,
      sections: included.map(({ section }) => ({
        id: section.id,
        kind: section.kind,
        required: section.required,
        priority: section.priority,
        byteLength: Buffer.byteLength(render(section)),
        digest: digest(section.content),
      })),
      omissions,
      byteLength: actualBytes,
      estimatedTokens: estimateTokens(actualBytes),
      digest: digest(text),
    };
  }
}

function render(section: ContextSection): string {
  const provenance = [
    section.sourceDigest ? `source-sha256=${section.sourceDigest}` : "",
    section.artifactHash ? `artifact=${section.artifactHash}` : "",
  ].filter(Boolean);
  return `## ${section.kind.toUpperCase()}: ${section.id}${
    provenance.length > 0 ? ` [${provenance.join("; ")}]` : ""
  }\n${section.content}`;
}

function joinedLength(values: readonly string[]): number {
  return values.reduce(
    (total, value, index) =>
      total + Buffer.byteLength(value) + (index > 0 ? 2 : 0),
    0
  );
}

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSections(sections: readonly ContextSection[]): void {
  const ids = new Set<string>();
  for (const section of sections) {
    if (!section.id.trim() || !section.kind.trim()) {
      throw new Error("Context sections require id and kind.");
    }
    if (ids.has(section.id)) throw new Error(`Duplicate context section ${section.id}.`);
    if (!Number.isFinite(section.priority)) {
      throw new Error(`Context section ${section.id} has invalid priority.`);
    }
    ids.add(section.id);
  }
}
