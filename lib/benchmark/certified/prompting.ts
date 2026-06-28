import type { ChatMessage } from "@/lib/providers/base";

export interface CertifiedPromptInput {
  system: string;
  user: string;
}

export function buildCertifiedMessages(input: CertifiedPromptInput): ChatMessage[] {
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
