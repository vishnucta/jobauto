import { NextResponse } from "next/server";

import { readAttachment } from "@/lib/attachments";
import { contentDisposition } from "@/lib/file-name";
import { route } from "@/lib/route";

/** An Anlage's PDF, to look at in the browser. */
export const GET = route<RouteContext<"/api/attachments/[id]">>(async (_request, { params }) => {
  const file = await readAttachment((await params).id);
  if (!file) return NextResponse.json({ error: "That Anlage is gone." }, { status: 404 });
  return new Response(Buffer.from(file.data), {
    headers: { "content-type": "application/pdf", "content-disposition": contentDisposition(file.fileName).replace(/^attachment/, "inline") },
  });
});
