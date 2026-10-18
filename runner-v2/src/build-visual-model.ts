import type { AgentMediaAttachment, AgentModel } from "./agent-contracts.js";
import { BuildUserMediaStore } from "./build-user-media.js";

const USER_MEDIA_REF = /AIBOARD_USER_MEDIA:([a-f0-9]{64}):([a-f0-9]{64})/g;

export function wrapModelWithBuildUserVisuals(
  model: AgentModel,
  store: BuildUserMediaStore,
  runId: string,
  inputCapabilities?: { image: boolean; document: boolean },
): AgentModel {
  return {
    async complete(request) {
      if (!inputCapabilities?.image && !inputCapabilities?.document) return model.complete(request);
      // Only evidence markers copied into the Architect/task context are opened.
      const references = new Map<string, { manifest: string; hash: string }>();
      for (const message of request.messages) {
        const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        if (!content.includes("AIBOARD_USER_MEDIA:")) continue;
        for (const match of content.matchAll(USER_MEDIA_REF)) {
          const manifest = match[1]!, hash = match[2]!;
          references.set(`${manifest}:${hash}`, { manifest, hash });
          if (references.size > 3) throw new Error("Visual task context exceeds 3 original attachments.");
        }
      }
      if (!references.size) return model.complete(request);
      const loaded: AgentMediaAttachment[] = [];
      for (const reference of references.values()) {
        const file = await store.loadByReference(runId, reference.manifest, reference.hash);
        if (!file) throw new Error("Referenced user visual evidence is not available for this run.");
        if ((file.mimeType === "application/pdf" && inputCapabilities.document) ||
            (file.mimeType.startsWith("image/") && inputCapabilities.image)) loaded.push(file);
      }
      // Non-vision workers still have the authenticated textual visual summary.
      return model.complete({ ...request, attachments: [...(request.attachments ?? []), ...loaded] });
    },
  };
}
