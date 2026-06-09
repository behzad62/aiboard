import { NextResponse } from "next/server";
import { getDiscussionById } from "@/lib/db";
import {
  emitDiscussionEvent,
} from "@/lib/orchestrator/events";
import {
  isDiscussionRunning,
  runDiscussion,
} from "@/lib/orchestrator/engine";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const discussion = getDiscussionById(id);

  if (!discussion) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (discussion.status === "completed") {
    return NextResponse.json({ message: "Already completed" });
  }

  if (!isDiscussionRunning(id)) {
    runDiscussion(id, (event) => emitDiscussionEvent(id, event)).catch(() => {
      emitDiscussionEvent(id, { type: "error", message: "Orchestration failed" });
    });
  }

  return NextResponse.json({ started: true });
}
