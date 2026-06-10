import { NextResponse } from "next/server";
import { z } from "zod";
import { getDecryptedApiKey, getProvider } from "@/lib/providers";
import { getDb, getProviderKey } from "@/lib/db";
import type { AttachmentPayload } from "@/lib/attachments/types";
import { getModelCapabilities } from "@/lib/providers/capabilities";
import { formatModelId } from "@/lib/providers/base";

import { PROVIDER_IDS } from "@/lib/providers/constants";

const schema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string().optional(),
  modelId: z.string().optional(),
});

const TEST_IMAGE: AttachmentPayload = {
  id: "test-image-red-dot",
  filename: "tiny-red-square.png",
  mimeType: "image/png",
  category: "image",
  base64Data:
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPY7ijpvafEjxqwKgBIDxqwDAwQO0/AEkhJx9IQd3PAAAAAElFTkSuQmCC",
};

async function runModelValidationTest(
  providerId: (typeof PROVIDER_IDS)[number],
  apiKey: string,
  modelId: string
): Promise<{ valid: boolean; usedImage: boolean; preview?: string; error?: string }> {
  const provider = getProvider(providerId);
  if (!provider) {
    return { valid: false, usedImage: false, error: "Unknown provider" };
  }

  const fullModelId = formatModelId(providerId, modelId);
  const caps = getModelCapabilities(fullModelId);
  const attachments = caps.image ? [TEST_IMAGE] : [];
  const prompt = caps.image
    ? "Look at the attached test image and reply with only 2 to 4 words describing its color and shape, for example 'red square'. Do not use a full sentence."
    : "Reply with one short sentence confirming this model test works.";

  const stream = provider.streamChat({
    apiKey,
    model: modelId,
    messages: [
      {
        role: "system",
        content: "You are validating that this model can answer a short settings test request.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    attachments,
    maxTokens: 80,
    temperature: 0.2,
  });

  let preview = "";
  for await (const chunk of stream) {
    if (chunk.type === "error") {
      return {
        valid: false,
        usedImage: attachments.length > 0,
        error: chunk.error ?? "Validation failed",
      };
    }
    if (chunk.type === "token" && chunk.content) {
      preview += chunk.content;
      if (preview.length >= 240) {
        break;
      }
    }
  }

  return {
    valid: preview.trim().length > 0,
    usedImage: attachments.length > 0,
    preview: preview.trim(),
    error: preview.trim().length > 0 ? undefined : "No response received from model",
  };
}

export async function POST(request: Request) {
  let providerId: (typeof PROVIDER_IDS)[number] | null = null;
  let usingSavedKey = false;

  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    providerId = parsed.data.providerId;
    const { apiKey: providedKey, modelId } = parsed.data;
    const provider = getProvider(providerId);
    if (!provider) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }

    const apiKey = providedKey ?? getDecryptedApiKey(providerId);
    usingSavedKey = !providedKey;
    if (!apiKey) {
      return NextResponse.json({ error: "No API key available" }, { status: 400 });
    }

    const savedProviderKey = getProviderKey(providerId);
    const selectedModelId =
      modelId ?? savedProviderKey?.defaultModel ?? provider.listModels()[0]?.id;

    if (!selectedModelId) {
      return NextResponse.json({ error: "No model available for testing" }, { status: 400 });
    }

    const result = await runModelValidationTest(providerId, apiKey, selectedModelId);
    const valid = result.valid;

    if (usingSavedKey && savedProviderKey) {
      getDb().updateProviderKey(providerId, {
        lastValidationSucceeded: valid,
        lastValidatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      valid,
      modelId: selectedModelId,
      usedImage: result.usedImage,
      preview: result.preview,
      error: result.error,
    });
  } catch (err) {
    if (providerId && usingSavedKey && getProviderKey(providerId)) {
      getDb().updateProviderKey(providerId, {
        lastValidationSucceeded: false,
        lastValidatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Validation failed", valid: false },
      { status: 500 }
    );
  }
}
