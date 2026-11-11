import type { ToolExecutionOutput } from "../../src/agent-contracts.js";

/** One stream's part of a read, rebuilt from the text blocks a model sees and the read's notes about them. */
export interface DecodedSlice {
  readonly stream: string;
  readonly text: string;
  /** The text's lines, when the read asked for lines. */
  readonly lines?: string[];
  readonly startLine?: number;
  readonly totalLines?: number;
  readonly hasMore?: boolean;
  readonly endOffset?: number;
  readonly totalBytes?: number;
  readonly startOffset?: number;
}

/**
 * The JSON blocks of a process tool's result, with each read's output put back beside it as slices. A read's output
 * comes as text blocks, one per stream, each starting with STDOUT or STDERR; a page too large for one block continues
 * in the next block with no heading (managed-process-tools.ts presentClientRead).
 */
export function decodeProcessToolOutput(output: ToolExecutionOutput): Record<string, unknown>[] {
  const values = output.content.filter((item) => item.type === "json").map((item) => (item as { value: Record<string, unknown> }).value);
  const texts: Array<{ stream: string; text: string }> = [];
  for (const block of output.content) {
    if (block.type !== "text") continue;
    const heading = /^(STDOUT|STDERR)\n/u.exec(block.text);
    if (heading) texts.push({ stream: heading[1]!.toLowerCase(), text: block.text.slice(heading[0].length) });
    else if (texts.length) texts[texts.length - 1]!.text += block.text;
  }
  const read = values.map((value) => (value.read ?? ("status" in value && !("pid" in value) ? value : undefined)) as Record<string, unknown> | undefined).find(Boolean);
  if (read) {
    const notes = (read.slices as Array<Record<string, unknown>> | undefined) ?? [];
    const streams = [...new Set([...texts.map((entry) => entry.stream), ...notes.map((note) => note.stream as string)])];
    read.slices = streams.map((stream) => {
      const note = notes.find((entry) => entry.stream === stream) ?? {};
      const text = texts.filter((entry) => entry.stream === stream).map((entry) => entry.text).join("");
      return { ...note, stream, text, ...("startLine" in note ? { lines: text.length ? text.split("\n") : [] } : {}) };
    });
  }
  return values;
}
