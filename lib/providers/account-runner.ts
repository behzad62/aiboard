import type { AIProvider, ChatParams, ModelInfo, StreamChunk } from "./base";

export const ACCOUNT_RUNNER_TEXT_ONLY = {
  image: false,
  document: false,
  audio: false,
  video: false,
} as const;

export const ACCOUNT_RUNNER_TEXT_AND_IMAGE_ATTACHMENTS = {
  image: true,
  document: true,
  audio: false,
  video: false,
} as const;

interface AccountRunnerProviderOptions {
  id: string;
  name: string;
  runnerPath: string;
  models: ModelInfo[];
}

interface AccountRunnerResponse {
  ok?: boolean;
  content?: string;
  error?: string;
}

function joinRunnerUrl(baseURL: string, path: string): string {
  const trimmed = baseURL.trim().replace(/\/$/, "");
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseRunnerResponse(response: Response): Promise<AccountRunnerResponse> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as AccountRunnerResponse;
  } catch {
    return { content: text };
  }
}

function unsupportedAttachmentReason(params: ChatParams): string | undefined {
  for (const attachment of params.attachments ?? []) {
    if (attachment.category === "image") {
      if (attachment.mimeType.startsWith("image/") && attachment.base64Data) continue;
      return `${attachment.filename} is missing image data`;
    }
    if (attachment.category === "text_inline" || attachment.category === "document") {
      if (typeof attachment.textContent === "string") continue;
      return `${attachment.filename} is not a text-readable document`;
    }
    return `${attachment.category} attachments are not supported by ${params.model}`;
  }
  return undefined;
}

export function createAccountRunnerProvider(
  options: AccountRunnerProviderOptions
): AIProvider {
  return {
    id: options.id,
    name: options.name,

    listModels() {
      return options.models;
    },

    async validateApiKey(apiKey: string) {
      // The key is the local runner token, not a provider API key. Full validation
      // needs the runner base URL, so Settings uses streamChat via validateProvider.
      return apiKey.trim().length > 0;
    },

    async *streamChat(params: ChatParams): AsyncIterable<StreamChunk> {
      const baseURL = params.baseURL?.trim();
      if (!baseURL) {
        yield {
          type: "error",
          error: `${options.name} needs the account-provider runner URL`,
        };
        return;
      }
      if (!params.apiKey.trim()) {
        yield {
          type: "error",
          error: `${options.name} needs the account-provider runner token`,
        };
        return;
      }
      const unsupported = unsupportedAttachmentReason(params);
      if (unsupported) {
        yield {
          type: "error",
          error: `${options.name} account-provider runner cannot send this attachment yet: ${unsupported}`,
        };
        return;
      }

      try {
        const response = await fetch(
          joinRunnerUrl(baseURL, `/providers/${options.runnerPath}/chat`),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-runner-token": params.apiKey,
            },
            body: JSON.stringify({
              model: params.model,
              messages: params.messages,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
              reasoningEffort: params.reasoningEffort,
              structuredOutput: params.structuredOutput,
              attachments: params.attachments ?? [],
            }),
          }
        );
        const data = await parseRunnerResponse(response);
        if (!response.ok || data.error) {
          yield {
            type: "error",
            error: data.error ?? `${options.name} runner request failed (${response.status})`,
          };
          return;
        }

        const content = data.content ?? "";
        if (content) yield { type: "token", content };
        yield { type: "done" };
      } catch (err) {
        yield {
          type: "error",
          error: err instanceof Error ? err.message : `${options.name} runner request failed`,
        };
      }
    },
  };
}
