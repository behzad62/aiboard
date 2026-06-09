import { NextResponse } from "next/server";
import {
  getDiscussionById,
  getFinalResult,
  getMessagesForDiscussion,
} from "@/lib/db";
import { getAttachments } from "@/lib/attachments/storage";

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
    attachments,
    finalResult: finalResult
      ? {
          ...finalResult,
          dissent: finalResult.dissent
            ? JSON.parse(finalResult.dissent)
            : [],
        }
      : null,
  });
}
