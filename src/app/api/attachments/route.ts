import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { addAttachment, ATTACHMENT_MAX_BYTES, AttachmentError } from "@/lib/attachments";
import { route } from "@/lib/route";

/**
 * Adds an Anlage (jobauto fork): the PDF as the request body, its file name
 * in `?name=`. A route handler rather than a Server Action, whose body limit
 * is 1 MB.
 */
export const POST = route(async (request) => {
  if (Number(request.headers.get("content-length") ?? 0) > ATTACHMENT_MAX_BYTES) {
    return NextResponse.json({ error: "That file is over 8 MB. Make it smaller, for example by scanning in black and white, and add it again." }, { status: 413 });
  }
  try {
    const attachment = await addAttachment(new Uint8Array(await request.arrayBuffer()), request.nextUrl.searchParams.get("name") ?? "Anlage.pdf");
    revalidatePath("/settings");
    return NextResponse.json(attachment);
  } catch (error) {
    if (error instanceof AttachmentError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
});
