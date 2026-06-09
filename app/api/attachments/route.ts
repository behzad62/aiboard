import { NextResponse } from "next/server";
import { saveAttachment, deleteAttachment } from "@/lib/attachments/storage";
import { MAX_ATTACHMENTS } from "@/lib/attachments/types";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files").filter((f): f is File => f instanceof File);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }
    if (files.length > MAX_ATTACHMENTS) {
      return NextResponse.json(
        { error: `Maximum ${MAX_ATTACHMENTS} files allowed` },
        { status: 400 }
      );
    }

    const saved = [];
    for (const file of files) {
      saved.push(await saveAttachment(file));
    }

    return NextResponse.json({ attachments: saved });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  deleteAttachment(id);
  return NextResponse.json({ ok: true });
}
