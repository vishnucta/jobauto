import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { importConnections, NetworkError } from "@/lib/network-data";
import { route } from "@/lib/route";

/** LinkedIn's Connections.csv can run to a few MB for a large network. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Takes her LinkedIn Connections.csv as the request body (jobauto fork) and
 * replaces her network with it. A route handler rather than a Server
 * Action, whose body limit is 1 MB.
 */
export const POST = route(async (request) => {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return NextResponse.json({ error: "That file is over 8 MB. Is it the Connections.csv?" }, { status: 413 });
  try {
    const people = await importConnections(await request.text());
    revalidatePath("/", "layout");
    return NextResponse.json({ people });
  } catch (error) {
    if (error instanceof NetworkError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
});
