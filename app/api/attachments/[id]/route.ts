import { NextResponse } from "next/server";
import fs from "fs";
import { getAttachment } from "@/lib/attachments/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const attachment = getAttachment(id);

  if (
    !attachment ||
    !attachment.storagePath ||
    !fs.existsSync(attachment.storagePath)
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const buffer = fs.readFileSync(attachment.storagePath);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Disposition": `inline; filename="${attachment.filename}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
