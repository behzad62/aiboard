import { NextResponse } from "next/server";
import {
  getDb,
  getDiscussionById,
  getFinalResult,
  getMessagesForDiscussion,
} from "@/lib/db";
import { getAttachments } from "@/lib/attachments/storage";
import { extractJudgeResult } from "@/lib/orchestrator/parse";
import { resolveModelName } from "@/lib/providers";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const discussion = getDiscussionById(id);
  if (!discussion) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  getDb().deleteDiscussion(id);
  return NextResponse.json({ ok: true });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const discussion = getDiscussionById(id);
  if (!discussion) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const messages = getMessagesForDiscussion(id);
  const finalResult = getFinalResult(id);

  // Resolve display names server-side so custom models (and any others) show
  // correctly in the transcript and panel, where the client can't read them.
  const participantIds: string[] = (() => {
    try {
      return JSON.parse(discussion.modelIds) as string[];
    } catch {
      return [];
    }
  })();
  const nameIds = new Set<string>([
    ...participantIds,
    ...messages.map((m) => m.modelId),
  ]);
  const modelNames: Record<string, string> = {};
  for (const fullId of nameIds) {
    modelNames[fullId] = resolveModelName(fullId);
  }

  const attachmentIds = discussion.attachmentIds
    ? (JSON.parse(discussion.attachmentIds) as string[])
    : [];
  const attachments = getAttachments(attachmentIds).map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    category: a.category,
    size: a.size,
  }));

  return NextResponse.json({
    discussion,
    messages,
    modelNames,
    attachments,
    finalResult: finalResult
      ? {
          ...finalResult,
          // Re-run the tolerant parser so answers persisted by older engine
          // versions (which could store a raw, truncated JSON envelope) render
          // as clean markdown. Idempotent for already-clean answers.
          answer: extractJudgeResult(finalResult.answer).answer,
          dissent: finalResult.dissent
            ? JSON.parse(finalResult.dissent)
            : [],
        }
      : null,
  });
}
