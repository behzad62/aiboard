import type { JsonSchemaObject, StructuredOutputFormat } from "./base";

const OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_PROVIDERS = new Set([
  "openai",
  "openrouter",
]);

export function openAICompatibleStructuredOutputField(
  providerId: string,
  format: StructuredOutputFormat | undefined
): {
  response_format?: {
    type: "json_schema";
    json_schema: StructuredOutputFormat;
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

function toGoogleSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const next: JsonSchemaObject = {};
  if (Array.isArray(schema.type)) {
    const nonNullTypes = schema.type.filter((type) => type !== "null");
    if (nonNullTypes.length === 1) next.type = nonNullTypes[0];
    else if (nonNullTypes.length > 1) next.type = nonNullTypes;
    if (schema.type.includes("null")) next.nullable = true;
  } else if (schema.type) {
    next.type = schema.type;
  }
  if (schema.description) next.description = schema.description;
  if (schema.maxLength !== undefined) next.maxLength = schema.maxLength;
  if (schema.minimum !== undefined) next.minimum = schema.minimum;
  if (schema.maximum !== undefined) next.maximum = schema.maximum;
  if (schema.minItems !== undefined) next.minItems = schema.minItems;
  if (schema.enum) next.enum = schema.enum;
  if (schema.required) next.required = schema.required;
  if (schema.nullable !== undefined) next.nullable = schema.nullable;
  if (schema.items) next.items = toGoogleSchema(schema.items);
  if (schema.properties) {
    next.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        toGoogleSchema(value),
      ])
    );
  }
  return next;
}

export function googleStructuredOutputConfig(
  format: StructuredOutputFormat | undefined
): {
  responseMimeType?: "application/json";
  responseSchema?: JsonSchemaObject;
} {
  if (!format) return {};
  return {
    responseMimeType: "application/json",
    responseSchema: toGoogleSchema(format.schema),
  };
}
