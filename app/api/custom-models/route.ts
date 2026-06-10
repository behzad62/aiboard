import { NextResponse } from "next/server";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import { encrypt } from "@/lib/crypto/keys";
import { getCustomModels, getDb } from "@/lib/db";
import type { CustomModel } from "@/lib/db/schema";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const capabilitiesSchema = z.object({
  image: z.boolean(),
  document: z.boolean(),
  audio: z.boolean(),
  video: z.boolean(),
});

const createSchema = z.object({
  label: z.string().min(1).max(80),
  baseURL: z.string().url(),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(400).optional(),
  capabilities: capabilitiesSchema.optional(),
});

const testSchema = z.object({
  action: z.literal("test"),
  baseURL: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
});

/** Never return key material to the browser. */
function redact(model: CustomModel) {
  return {
    id: model.id,
    label: model.label,
    baseURL: model.baseURL,
    model: model.model,
    hasKey: model.hasKey,
    capabilities: model.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    },
    createdAt: model.createdAt,
  };
}

export async function GET() {
  return NextResponse.json({ customModels: getCustomModels().map(redact) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (body?.action === "test") {
      const parsed = testSchema.safeParse(body);
      if (!parsed.success) {
        return NextResponse.json(
          { valid: false, error: "Invalid test request" },
          { status: 400 }
        );
      }
      const { baseURL, model, apiKey } = parsed.data;
      try {
        const client = new OpenAI({ apiKey: apiKey || "not-needed", baseURL });
        const res = await client.chat.completions.create({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with OK" }],
        });
        const preview = res.choices[0]?.message?.content ?? "(empty response)";
        return NextResponse.json({ valid: true, preview });
      } catch (err) {
        return NextResponse.json({
          valid: false,
          error: err instanceof Error ? err.message : "Connection failed",
        });
      }
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? "Invalid input" },
        { status: 400 }
      );
    }

    const { label, baseURL, model, apiKey, capabilities } = parsed.data;
    const payload = apiKey ? encrypt(apiKey) : null;
    const record: CustomModel = {
      id: uuidv4(),
      label,
      baseURL,
      model,
      encryptedKey: payload?.encrypted ?? null,
      iv: payload?.iv ?? null,
      authTag: payload?.authTag ?? null,
      hasKey: !!payload,
      capabilities,
      createdAt: new Date().toISOString(),
    };
    getDb().addCustomModel(record);
    return NextResponse.json({ ok: true, id: record.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save" },
      { status: 500 }
    );
  }
}

const updateSchema = z.object({
  id: z.string().min(1),
  capabilities: capabilitiesSchema,
});

export async function PATCH(request: Request) {
  try {
    const parsed = updateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    getDb().updateCustomModel(parsed.data.id, {
      capabilities: parsed.data.capabilities,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  getDb().deleteCustomModel(id);
  return NextResponse.json({ ok: true });
}
