import "server-only";

import { linkKey } from "@/lib/job-search/search";
import { prisma } from "@/lib/prisma";

// One application per posting (jobauto fork, audit round 2). Positions'
// Prepare it for me and the job agent's Prepare it for me write with the
// one writer (write-application.ts), and before either writes, it asks
// here whether the posting has an application already, made by the other
// button, by New application from the same link, or by Claude.

/** The key of a posting's preparation (Prepare it for me), so a second click follows the one under way. */
export const prepareJobKey = (postingId: string) => `prepare:${postingId}`;

type PostingRef = { source: string; externalId: string; url: string };

/**
 * The application a posting has outside the job agent's queue: the one
 * Positions keeps with it (or with the posting it was merged into), else
 * one made from the same link, as Positions' "Applied" counts it. An agent
 * draft still waiting for review isn't one: it's the agent's to settle.
 */
export async function keptApplication(ref: PostingRef): Promise<string | null> {
  const posting = await prisma.posting.findUnique({
    where: { source_externalId: { source: ref.source, externalId: ref.externalId } },
    select: { applicationId: true, mergedInto: { select: { applicationId: true } } },
  });
  const kept = posting?.applicationId ?? posting?.mergedInto?.applicationId ?? null;
  return kept ?? sameLinkApplication(ref.url);
}

/** An application made from the same link, for a posting Positions doesn't keep (save_application from a link). */
export async function sameLinkApplication(url: string): Promise<string | null> {
  const link = linkKey(url);
  if (!link) return null;
  const sameLink = await prisma.application.findMany({ where: { postingUrl: { not: "" }, awaitingReview: false }, select: { id: true, postingUrl: true }, orderBy: { createdAt: "asc" } });
  return sameLink.find((application) => linkKey(application.postingUrl) === link)?.id ?? null;
}

/** The posting Positions keeps for a ref, for the Prepare it for me under way for it; null when it keeps none. */
export async function keptPostingId(ref: Pick<PostingRef, "source" | "externalId">): Promise<string | null> {
  const posting = await prisma.posting.findUnique({ where: { source_externalId: { source: ref.source, externalId: ref.externalId } }, select: { id: true } });
  return posting?.id ?? null;
}
