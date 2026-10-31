import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { applyDir, SCREENSHOTS } from "@/lib/apply/files";
import { prisma } from "@/lib/prisma";
import { route } from "@/lib/route";

const GONE = "That screenshot isn't here any more.";

/** A screenshot an apply run took (Phase A): the filled form, or the confirmation page. */
export const GET = route<RouteContext<"/api/apply/[id]/[shot]">>(async (_request, { params }) => {
  const { id, shot } = await params;
  const name = shot === "filled" ? SCREENSHOTS.filled : shot === "confirmation" ? SCREENSHOTS.confirmation : null;
  if (!name) return NextResponse.json({ error: GONE }, { status: 404 });
  const attempt = await prisma.applyAttempt.findUnique({ where: { id }, select: { screenshot: true, confirmation: true } });
  if (!attempt || !(shot === "filled" ? attempt.screenshot : attempt.confirmation)) return NextResponse.json({ error: GONE }, { status: 404 });
  const file = await readFile(path.join(applyDir(id), name)).catch(() => null);
  if (!file) return NextResponse.json({ error: GONE }, { status: 410 });
  return new Response(file, { headers: { "content-type": "image/png" } });
});
