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

function toGoogleSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const next: JsonSchemaObject = {};
  if (schema.type) next.type = schema.type;
  if (schema.description) next.description = schema.description;
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
