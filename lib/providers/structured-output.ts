import type { JsonSchemaObject, StructuredOutputFormat } from "./base";

const OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_PROVIDERS = new Set([
  "openai",
  "openrouter",
  "nvidia",
]);

export function openAICompatibleStructuredOutputField(
  providerId: string,
  format: StructuredOutputFormat | undefined
): {
  response_format?: {
    type: "json_schema";
    json_schema: StructuredOutputFormat;
  };
  provider?: {
    require_parameters: true;
  };
} {
  if (!format || !OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_PROVIDERS.has(providerId)) {
    return {};
  }

  return {
    response_format: {
      type: "json_schema",
      json_schema: format,
    },
    ...(providerId === "openrouter"
      ? { provider: { require_parameters: true as const } }
      : {}),
  };
}

export function openAIResponsesTextFormatField(
  format: StructuredOutputFormat | undefined
): Record<string, unknown> {
  if (!format) return {};
  return {
    text: {
      format: {
        type: "json_schema",
        name: format.name,
        schema: format.schema,
        strict: format.strict ?? false,
      },
    },
  };
}

export function anthropicStructuredToolConfig(
  format: StructuredOutputFormat | undefined
): {
  tools?: Array<{
    name: string;
    description: string;
    input_schema: JsonSchemaObject;
  }>;
  tool_choice?: {
    type: "tool";
    name: string;
    disable_parallel_tool_use: true;
  };
} {
  if (!format) return {};
  return {
    tools: [
      {
        name: format.name,
        description:
          "Return the requested structured JSON object. The application reads this tool input as the model response.",
        input_schema: format.schema,
      },
    ],
    tool_choice: {
      type: "tool",
      name: format.name,
      disable_parallel_tool_use: true,
    },
  };
}

export function googleStructuredOutputConfig(
  format: StructuredOutputFormat | undefined
): {
  responseMimeType?: "application/json";
  responseJsonSchema?: JsonSchemaObject;
} {
  if (!format) return {};
  return {
    responseMimeType: "application/json",
    responseJsonSchema: format.schema,
  };
}
