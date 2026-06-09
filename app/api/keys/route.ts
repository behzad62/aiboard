import { NextResponse } from "next/server";
import { z } from "zod";
import { encrypt } from "@/lib/crypto/keys";
import { getDb, getProviderKeys, getUserSettings } from "@/lib/db";
import { maskApiKey } from "@/lib/utils";
import { getAllProviders } from "@/lib/providers";

import { PROVIDER_IDS } from "@/lib/providers/constants";

const keySchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string().min(10).optional(),
  defaultModel: z.string().optional(),
  enabled: z.boolean().optional(),
});

const settingsSchema = z.object({
  defaultEffort: z.enum(["low", "medium", "high"]).optional(),
  defaultMode: z.enum(["panel", "debate", "specialist"]).optional(),
  judgeModelId: z.string().optional(),
});

export async function GET() {
  const keys = getProviderKeys();
  const settings = getUserSettings();
  const providers = getAllProviders().map((p) => {
    const saved = keys.find((k) => k.providerId === p.id);
    return {
      providerId: p.id,
      name: p.name,
      models: p.listModels(),
      hasKey: !!saved,
      keyHint: saved?.keyHint,
      defaultModel: saved?.defaultModel,
      enabled: saved?.enabled ?? false,
    };
  });

  return NextResponse.json({ providers, settings });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body.type === "settings") {
      const parsed = settingsSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
      }
      getDb().updateUserSettings(parsed.data);
      return NextResponse.json({ ok: true });
    }

    const parsed = keySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { providerId, apiKey, defaultModel, enabled } = parsed.data;
    const existing = getProviderKeys().find((k) => k.providerId === providerId);

    if (!apiKey && !existing) {
      return NextResponse.json({ error: "API key required" }, { status: 400 });
    }

    const payload = apiKey ? encrypt(apiKey) : null;
    const now = new Date().toISOString();

    if (existing) {
      getDb().updateProviderKey(providerId, {
        ...(payload
          ? {
              encryptedKey: payload.encrypted,
              iv: payload.iv,
              authTag: payload.authTag,
              keyHint: maskApiKey(apiKey!),
            }
          : {}),
        defaultModel: defaultModel ?? existing.defaultModel,
        enabled: enabled ?? existing.enabled,
        updatedAt: now,
      });
    } else if (payload && apiKey) {
      getDb().upsertProviderKey({
        providerId,
        encryptedKey: payload.encrypted,
        iv: payload.iv,
        authTag: payload.authTag,
        defaultModel: defaultModel ?? null,
        enabled: enabled ?? true,
        keyHint: maskApiKey(apiKey),
        updatedAt: now,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 }
    );
  }
}
