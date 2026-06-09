import { NextResponse } from "next/server";
import { getDiscussionById } from "@/lib/db";
import {
  emitDiscussionEvent,
  subscribeToDiscussion,
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const discussion = getDiscussionById(id);

  if (!discussion) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
        );
      };

      unsubscribe = subscribeToDiscussion(id, (event) => {
        send(event);
        if (event.type === "complete" || event.type === "error") {
          controller.close();
        }
      });

      if (
        discussion.status === "pending" &&
        !isDiscussionRunning(id)
      ) {
        runDiscussion(id, (event) => emitDiscussionEvent(id, event)).catch(
          () => {
            emitDiscussionEvent(id, {
              type: "error",
              message: "Orchestration failed",
            });
          }
        );
      }

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        controller.close();
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
