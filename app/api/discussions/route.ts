import { NextResponse } from "next/server";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { getAttachments } from "@/lib/attachments/storage";
import { getRequiredCapabilityTypes } from "@/lib/attachments/classify";
import { getDb, listDiscussions, getUserSettings } from "@/lib/db";
import { EFFORT_CONFIG } from "@/lib/orchestrator/config";
import type { DiscussionMode, EffortLevel } from "@/lib/db/schema";
import { getEnabledModels } from "@/lib/providers";
import { modelSupportsInputTypes } from "@/lib/providers/capabilities";

const createSchema = z.object({
  topic: z.string().min(10).max(10000),
  mode: z.enum(["panel", "debate", "specialist"]),
  effort: z.enum(["low", "medium", "high"]),
  modelIds: z.array(z.string()).min(2, "Select at least 2 models"),
  judgeModelId: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
});

export async function GET() {
  const discussions = listDiscussions();
  const settings = getUserSettings();
  const enabledModels = getEnabledModels();

  return NextResponse.json({
    discussions,
    settings,
    enabledModels: enabledModels.map((m) => ({
      ...m,
      fullId: `${m.providerId}:${m.id}`,
    })),
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? "Invalid input" },
        { status: 400 }
      );
    }

    const { topic, mode, effort, modelIds, judgeModelId, attachmentIds = [] } =
      parsed.data;
    const enabled = getEnabledModels().map((m) => `${m.providerId}:${m.id}`);
    const invalid = modelIds.filter((id) => !enabled.includes(id));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: "Some selected models are not configured" },
        { status: 400 }
      );
    }

    const attachments = getAttachments(attachmentIds);
    if (attachments.length !== attachmentIds.length) {
      return NextResponse.json(
        { error: "One or more attachments were not found" },
        { status: 400 }
      );
    }

    const requiredTypes = getRequiredCapabilityTypes(
      attachments.map((a) => a.category)
    );
    const incompatible = modelIds.filter(
      (id) => !modelSupportsInputTypes(id, requiredTypes)
    );
    if (incompatible.length > 0) {
      return NextResponse.json(
        { error: "Selected models do not support all attached file types" },
        { status: 400 }
      );
    }

    const judge = judgeModelId ?? modelIds[0];
    if (!modelSupportsInputTypes(judge, requiredTypes)) {
      return NextResponse.json(
        { error: "Judge model does not support all attached file types" },
        { status: 400 }
      );
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const config = EFFORT_CONFIG[effort as EffortLevel];

    getDb().insertDiscussion({
      id,
      topic,
      mode: mode as DiscussionMode,
      effort: effort as EffortLevel,
      status: "pending",
      modelIds: JSON.stringify(modelIds),
      judgeModelId: judge,
      attachmentIds:
        attachmentIds.length > 0 ? JSON.stringify(attachmentIds) : null,
      currentRound: 0,
      maxRounds: config.maxRounds,
      convergenceScore: null,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create discussion" },
      { status: 500 }
    );
  }
}
