import { NextResponse } from "next/server";
import { z } from "zod";
import { encrypt } from "@/lib/crypto/keys";
import { getDb, getProviderKeys, getUserSettings } from "@/lib/db";
import { maskApiKey } from "@/lib/utils";
import { getAllProviders } from "@/lib/providers";

import { PROVIDER_IDS } from "@/lib/providers/constants";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const keySchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string().min(10).optional(),
  defaultModel: z.string().optional(),
  enabled: z.boolean().optional(),
});

const settingsSchema = z.object({
  defaultEffort: z.enum(["low", "medium", "high"]).optional(),
  defaultMode: z.enum(["panel", "debate", "specialist", "build"]).optional(),
  judgeModelId: z.string().optional(),
  defaultVerbosity: z
    .enum(["brief", "balanced", "comprehensive", "exhaustive"])
    .optional(),
  defaultStyleNote: z.string().max(2000).optional(),
  defaultReasoningEffort: z
    .enum(["default", "low", "medium", "high", "max"])
    .optional(),
});

const pricingOverrideSchema = z.object({
  type: z.literal("pricing_override"),
  fullModelId: z.string().min(1),
  inputUsdPer1M: z.number().nonnegative().optional(),
  outputUsdPer1M: z.number().nonnegative().optional(),
  cachedInputUsdPer1M: z.number().nonnegative().nullable().optional(),
  clear: z.boolean().optional(),
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
      lastValidationSucceeded: saved?.lastValidationSucceeded ?? null,
      lastValidatedAt: saved?.lastValidatedAt ?? null,
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

    if (body.type === "pricing_override") {
      const parsed = pricingOverrideSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json({ error: "Invalid pricing override" }, { status: 400 });
      }

      const settings = getUserSettings();
      const nextOverrides = {
        ...(settings.modelPricingOverrides ?? {}),
      };

      if (parsed.data.clear) {
        delete nextOverrides[parsed.data.fullModelId];
      } else {
        if (
          parsed.data.inputUsdPer1M === undefined ||
          parsed.data.outputUsdPer1M === undefined
        ) {
          return NextResponse.json(
            { error: "Input and output pricing are required" },
            { status: 400 }
          );
        }

        nextOverrides[parsed.data.fullModelId] = {
          inputUsdPer1M: parsed.data.inputUsdPer1M,
          outputUsdPer1M: parsed.data.outputUsdPer1M,
          cachedInputUsdPer1M: parsed.data.cachedInputUsdPer1M ?? null,
          updatedAt: new Date().toISOString(),
        };
      }

      getDb().updateUserSettings({ modelPricingOverrides: nextOverrides });
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
              lastValidationSucceeded: null,
              lastValidatedAt: null,
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
        lastValidationSucceeded: null,
        lastValidatedAt: null,
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
