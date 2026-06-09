import { NextResponse } from "next/server";
import { z } from "zod";
import { getDecryptedApiKey, getProvider } from "@/lib/providers";

import { PROVIDER_IDS } from "@/lib/providers/constants";

const schema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  apiKey: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { providerId, apiKey: providedKey } = parsed.data;
    const provider = getProvider(providerId);
    if (!provider) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }

    const apiKey = providedKey ?? getDecryptedApiKey(providerId);
    if (!apiKey) {
      return NextResponse.json({ error: "No API key available" }, { status: 400 });
    }

    const valid = await provider.validateApiKey(apiKey);
    return NextResponse.json({ valid });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Validation failed", valid: false },
      { status: 500 }
    );
  }
}
