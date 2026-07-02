import type { ChatMessage } from "@/lib/providers/base";

export interface CertifiedPromptInput {
  system: string;
  user: string;
  /**
   * Full multi-turn conversation override. When provided, it is sent verbatim
   * instead of the derived [system, user] pair — used by memory benchmark paths
   * that replay clue history as earlier conversation turns. It is still ONE
   * model call, just with more messages. Callers that only set system/user get
   * byte-identical behavior to before.
   */
  messages?: ChatMessage[];
}

export function buildCertifiedMessages(input: CertifiedPromptInput): ChatMessage[] {
  if (input.messages && input.messages.length > 0) {
    return input.messages;
  }
  return [
    {
      role: "system",
      content: input.system,
    },
    {
      role: "user",
      content: input.user,
    },
  ];
}

export function certifiedPromptText(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
}
