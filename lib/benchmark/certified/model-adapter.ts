import type {
  ChatMessage,
  SelectedModel,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import type { CertifiedMockModel } from "./mock-models";

export interface CertifiedModelOverrideInput {
  model: SelectedModel;
  messages: ChatMessage[];
  maxTokens: number;
  label: string;
  structuredOutput?: StructuredOutputFormat;
}

export function createCertifiedModelCallOverride(
  models: CertifiedMockModel[]
): (input: CertifiedModelOverrideInput) => Promise<string> {
  const byId = new Map(models.map((model) => [model.modelId, model]));
  return async (input) => {
    const model = byId.get(input.model.modelId);
    if (!model) {
      throw new Error(`No certified mock model registered for ${input.model.modelId}`);
    }
    return model.responseFor({
      label: input.label,
      messages: input.messages,
    });
  };
}
