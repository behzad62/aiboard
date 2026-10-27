import type { AgentMessage, AgentModel, ArtifactBlock, ToolResult, ToolVisualInput } from "./agent-contracts.js";

/** At most this many tool images accompany one model request (the newest win). */
export const MAX_TOOL_VISUALS_PER_REQUEST = 4;
const DELIVERABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Visual artifacts in the tool results this request answers: those after the newest assistant
 * message. Older results keep only their textual reference, so an image is attached once.
 */
export function pendingVisualArtifacts(messages: readonly AgentMessage[]): Array<{ callId: string; block: ArtifactBlock & { visual: NonNullable<ArtifactBlock["visual"]> } }> {
  let latestAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index]!.role === "assistant") { latestAssistant = index; break; }
  const found: Array<{ callId: string; block: ArtifactBlock & { visual: NonNullable<ArtifactBlock["visual"]> } }> = [];
  const seen = new Set<string>();
  for (const message of messages.slice(latestAssistant + 1)) {
    if (message.role !== "tool" || Array.isArray(message.content) || typeof message.content === "string") continue;
    const result = message.content as ToolResult;
    if (result.isError) continue;
    for (const block of result.content ?? []) {
      if (block.type !== "artifact" || !block.visual || !DELIVERABLE.has(block.mediaType)) continue;
      const key = `${result.callId}\0${block.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ callId: result.callId, block: block as ArtifactBlock & { visual: NonNullable<ArtifactBlock["visual"]> } });
    }
  }
  return found.slice(-MAX_TOOL_VISUALS_PER_REQUEST);
}

/**
 * Declares image input and resolves pending tool images into request.toolVisuals. A text-only
 * model is never sent image bytes; tools learn the modality from ToolExecutionContext.imageInput.
 */
export function wrapModelWithToolVisuals(
  model: AgentModel,
  options: Readonly<{ image: boolean; readArtifact?: (hash: string) => Promise<Buffer>; resolveInAdapter?: boolean }>,
): AgentModel {
  return {
    ...(model.contextWindowTokens !== undefined ? { contextWindowTokens: model.contextWindowTokens } : {}),
    inputModalities: Object.freeze({ image: options.image }),
    async complete(request) {
      // Account-runner transports forward pending tool images themselves.
      if (!options.image || options.resolveInAdapter || !options.readArtifact) return await model.complete(request);
      const pending = pendingVisualArtifacts(request.messages);
      if (!pending.length) return await model.complete(request);
      const toolVisuals: ToolVisualInput[] = [];
      for (const { callId, block } of pending) {
        const bytes = await options.readArtifact(block.hash);
        toolVisuals.push(Object.freeze({ callId, hash: block.hash, mimeType: block.mediaType as ToolVisualInput["mimeType"], base64Data: bytes.toString("base64"),
          ...(block.label ? { label: block.label } : {}) }));
      }
      return await model.complete({ ...request, toolVisuals: Object.freeze(toolVisuals) });
    },
  };
}

/** Preserve declared modalities across model wrappers that rebuild the model object. */
export function withModalitiesOf<T extends AgentModel>(source: AgentModel, wrapped: T): T {
  return source.inputModalities && !wrapped.inputModalities ? { ...wrapped, inputModalities: source.inputModalities } : wrapped;
}

export function visualsForCall(request: { toolVisuals?: readonly ToolVisualInput[] }, callId: string): ToolVisualInput[] {
  return (request.toolVisuals ?? []).filter(visual => visual.callId === callId);
}

/** Caption that ties an image to its tool call, for transports that carry images in a separate message. */
export function toolVisualCaption(visuals: readonly ToolVisualInput[]): string {
  const calls = [...new Set(visuals.map(visual => visual.callId))];
  return `Image content returned by tool call${calls.length === 1 ? "" : "s"} ${calls.join(", ")} (${visuals.map(visual => visual.label ?? visual.hash.slice(0, 12)).join("; ")}).`;
}
