import "server-only";

import { z } from "zod";

import type { AgentCandidate, Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { AiError } from "@/lib/ai/errors";
import { fullText } from "@/lib/job-search/find";
import { postingText, safeLink, type FoundPosting } from "@/lib/job-search/search";
import { cancelJob, defineJob, findUnfinishedJobs, startJob, type JobContext } from "@/lib/jobs/runner";
import { writeApplication } from "@/lib/jobs/write-application";
import { logServerError } from "@/lib/log";
import { dismissPosting, storePosting, unmarkPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { emit } from "@/lib/notifications/notify";
import { keptApplication, keptPostingId, prepareJobKey } from "@/lib/posting-application";
import { profileIdOr } from "@/lib/profiles";

import { DISMISSED_TRIM, stringsOf } from "./candidates";
import { lockAgentSearches } from "./searches";
import { bestProfileFor } from "@/lib/posting-scores";

// A candidate's draft (E16-5): written the way New application writes one,
// kept off Applications until it's approved (#195), and never sent.
// Adapted from avinashbatchala's fork of Dossier.

/** The key of a candidate's draft job, so a second click finds the one under way. */
export const draftJobKey = (candidateId: string) => `agent-candidate:${candidateId}`;

/** A candidate in the shape search results have. */
function foundFromCandidate(candidate: AgentCandidate): FoundPosting {
  return {
    source: candidate.source,
    externalId: candidate.externalId,
    title: candidate.title,
    company: candidate.company,
    place: candidate.place,
    remote: candidate.remote,
    salary: candidate.salary,
    postedAt: candidate.postedAt?.toISOString() ?? null,
    url: candidate.url,
    via: candidate.via,
    description: candidate.description,
    complete: candidate.complete,
  };
}

/**
 * A posting that has an application already (Prepare it for me on
 * Positions, New application from the same link): the candidate takes it as
 * approved, so the agent never writes a second one (jobauto fork, audit
 * round 2). It leaves the agent's queue; the application is in Applications.
 */
async function adoptApplication(candidateId: string, applicationId: string): Promise<string> {
  // Another candidate holding it (the same job from another portal) keeps it; this one is settled all the same.
  const holder = await prisma.agentCandidate.findUnique({ where: { applicationId }, select: { id: true } });
  await prisma.agentCandidate.updateMany({
    where: { id: candidateId, status: { in: [AgentCandidateStatus.SCORED, AgentCandidateStatus.DRAFTING] } },
    data: { status: AgentCandidateStatus.APPROVED, error: null, ...(holder ? {} : { applicationId }) },
  });
  return applicationId;
}

/**
 * Prepares a candidate's draft. It's claimed first (SCORED → DRAFTING), so a
 * retry, a second click and auto-draft can't make two applications; a failure
 * sends it back to SCORED with the error to show. A posting with an
 * application already gets no second one: the candidate takes that one.
 * Returns the application.
 */
export async function draftCandidate(candidateId: string, context: JobContext): Promise<string> {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new ActionError("That posting is no longer in the agent's queue.");
  if (candidate.status === AgentCandidateStatus.DRAFTED && candidate.applicationId) return candidate.applicationId;
  if (candidate.status === AgentCandidateStatus.SCORED) {
    const kept = await keptApplication(candidate);
    if (kept) return adoptApplication(candidateId, kept);
    const postingId = await keptPostingId(candidate);
    if (postingId && (await findUnfinishedJobs(prepareJobKey(postingId))).length > 0) {
      throw new ActionError("Prepare it for me is writing this posting's application on Positions already.");
    }
  }
  const { count } = await prisma.agentCandidate.updateMany({
    where: { id: candidateId, status: AgentCandidateStatus.SCORED },
    data: { status: AgentCandidateStatus.DRAFTING, error: null },
  });
  if (count === 0) throw new ActionError("That posting is no longer waiting for a draft.");

  const name = candidate.company || candidate.title || "the posting";
  try {
    const found = foundFromCandidate(candidate);
    // The source may have given only a snippet; the whole text writes a better draft.
    const description = (await fullText(found)) ?? candidate.description;
    if (!description.trim()) throw new ActionError("That posting has no text to write from. Open it and start an application by hand.");

    // Written from the profile of the search that found it first (E24-6), or the one that scored it best when that search scores against all (E25-5); the first profile's when that search is gone.
    const foundBy = await prisma.agentCandidateSearch.findFirst({
      where: { candidateId, search: { isNot: null } },
      orderBy: { createdAt: "asc" },
      select: { search: { select: { profileId: true, allProfiles: true } } },
    });
    const best = foundBy?.search?.allProfiles ? await bestProfileFor(candidate) : null;
    const profileId = await profileIdOr(best ?? foundBy?.search?.profileId);

    // Keep the whole text, so a retry doesn't fetch it again.
    if (!candidate.complete && description !== candidate.description) {
      await prisma.agentCandidate.update({ where: { id: candidateId }, data: { description, complete: true } });
    }
    // Read, written and created as Prepare it for me does (write-application.ts, jobauto fork). Its score for
    // that profile, when the agent kept one, answers How you match with no new call (E25-7).
    return await writeApplication(
      {
        posting: postingText({ ...found, description }),
        postingUrl: candidate.url,
        name,
        write: "both",
        claim: { kind: "agent", candidateId, score: candidate.score },
        profileId,
        scored: { source: candidate.source, externalId: candidate.externalId },
      },
      context,
    );
  } catch (error) {
    const known = error instanceof AiError || error instanceof ActionError;
    const message = context.signal.aborted ? "Cancelled." : known ? error.message : "The draft couldn't be prepared. Try again.";
    await prisma.agentCandidate.updateMany({ where: { id: candidateId, status: AgentCandidateStatus.DRAFTING }, data: { status: AgentCandidateStatus.SCORED, error: message } });
    if (!known && !context.signal.aborted) logServerError("job agent draft", error);
    throw error;
  }
}

/** Prepares one candidate's draft in the background (E16-5): from Prepare it for me, or a run with auto-draft on. */
export const agentDraftJob = defineJob({
  type: "agent-draft",
  input: z.object({
    candidateId: z.string().min(1),
    /** Prepared by the agent on its own (auto-draft), which sends "A draft is ready" (E26-6); Prepare it for me never does. */
    auto: z.boolean().default(false),
  }),
  result: z.object({ applicationId: z.string().min(1) }),
  run: async ({ candidateId, auto }, context) => {
    const applicationId = await draftCandidate(candidateId, context);
    if (auto) {
      const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId }, select: { status: true, title: true, company: true, covered: true, requirements: true } });
      // A draft it wrote, not an application she had already (adoptApplication).
      if (candidate?.status === AgentCandidateStatus.DRAFTED) {
        await emit("draft.ready", { applicationId, title: candidate.title, company: candidate.company, coverage: candidate.requirements > 0 ? { hit: candidate.covered, total: candidate.requirements } : null });
      }
    }
    return { applicationId };
  },
});

/**
 * Prepare it for me (E16-5), from the Agent screen or from Claude: starts a
 * candidate's draft in the background. A draft under way is reused, and one
 * already made is answered with; `started` says whether a job began.
 */
export async function startCandidateDraft(candidateId: string): Promise<{ jobId: string | null; applicationId: string | null; started: boolean }> {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId }, select: { status: true, applicationId: true, source: true, externalId: true, url: true } });
  if (!candidate) throw new ActionError("That posting is no longer in the agent's queue.");
  if (candidate.status === AgentCandidateStatus.DRAFTED && candidate.applicationId) return { jobId: null, applicationId: candidate.applicationId, started: false };
  const [unfinished] = await findUnfinishedJobs(draftJobKey(candidateId));
  if (unfinished) return { jobId: unfinished.id, applicationId: null, started: false };
  if (candidate.status !== AgentCandidateStatus.SCORED) throw new ActionError("That posting is no longer waiting for a draft.");
  // One application per posting (jobauto fork): one made already is answered with, one being prepared on Positions is followed.
  const kept = await keptApplication(candidate);
  if (kept) return { jobId: null, applicationId: await adoptApplication(candidateId, kept), started: false };
  const postingId = await keptPostingId(candidate);
  const [preparing] = postingId ? await findUnfinishedJobs(prepareJobKey(postingId)) : [];
  if (preparing) return { jobId: preparing.id, applicationId: null, started: false };
  // Asked for, so no "A draft is ready" message (E26-6).
  const jobId = await startJob(agentDraftJob, { candidateId, auto: false }, { key: draftJobKey(candidateId) });
  return { jobId, applicationId: null, started: true };
}

/**
 * Approve: the draft becomes a normal Draft application, shown everywhere,
 * and its posting shows as applied for in Find jobs. Nothing is sent.
 */
export async function approveCandidate(candidateId: string): Promise<string> {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate || candidate.status !== AgentCandidateStatus.DRAFTED || !candidate.applicationId) {
    throw new ActionError("That draft isn't ready to approve.");
  }
  const applicationId = candidate.applicationId;
  const posting = await storePosting(foundFromCandidate(candidate));
  await prisma.$transaction([
    prisma.agentCandidate.update({ where: { id: candidateId }, data: { status: AgentCandidateStatus.APPROVED } }),
    prisma.application.update({ where: { id: applicationId }, data: { awaitingReview: false } }),
    // One already linked to another application keeps it.
    prisma.posting.updateMany({ where: { id: posting.id, applicationId: null }, data: { applicationId } }),
  ]);
  return applicationId;
}

/** What a dismissed candidate had, for Undo on the toast. */
export type DismissedCandidate = Pick<
  AgentCandidate,
  "id" | "place" | "remote" | "salary" | "postedAt" | "url" | "via" | "description" | "complete" | "reasons" | "redFlags"
>;

/**
 * Dismiss: a draft in progress is cancelled, a draft is deleted with its
 * documents, chat and notes, and the posting is marked dismissed in Find
 * jobs, so it never comes back. The candidate stays, trimmed to what dedupe
 * needs. Returns what was trimmed, for Undo while there was no draft.
 */
export async function dismissCandidate(candidateId: string): Promise<{ undo: DismissedCandidate | null }> {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new ActionError("That posting is no longer in the agent's queue.");
  if (candidate.status === AgentCandidateStatus.DISMISSED) return { undo: null };
  if (candidate.status === AgentCandidateStatus.APPROVED) throw new ActionError("That draft was approved: it's in Applications now.");

  for (const job of await findUnfinishedJobs(draftJobKey(candidateId))) await cancelJob(job.id);
  const hadDraft = Boolean(candidate.applicationId) || candidate.status !== AgentCandidateStatus.SCORED;
  await dismissPosting(foundFromCandidate(candidate));
  await prisma.$transaction(async (tx) => {
    // Serialized with attribution, so a scan can't put labels back after the dismissal (public PR 61).
    await lockAgentSearches(tx);
    // Locked (by a write that changes nothing), so a draft that's just being created either lands first and is deleted here, or finds it dismissed and isn't made.
    await tx.$executeRaw`UPDATE "AgentCandidate" SET id = id WHERE id = ${candidateId}`;
    const current = await tx.agentCandidate.findUniqueOrThrow({ where: { id: candidateId }, select: { applicationId: true } });
    if (current.applicationId) await tx.application.deleteMany({ where: { id: current.applicationId } });
    await tx.agentCandidate.update({ where: { id: candidateId }, data: { status: AgentCandidateStatus.DISMISSED, ...DISMISSED_TRIM } });
    await tx.agentCandidateSearch.deleteMany({ where: { candidateId } });
  });
  const { id, place, remote, salary, postedAt, url, via, description, complete, reasons, redFlags } = candidate;
  return { undo: hadDraft ? null : { id, place, remote, salary, postedAt, url, via, description, complete, reasons, redFlags } };
}

/** Undo on a dismissed posting's toast: back in the queue as it was, and out of Find jobs' Dismissed. */
export async function restoreCandidate(saved: DismissedCandidate): Promise<void> {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: saved.id } });
  if (candidate?.status !== AgentCandidateStatus.DISMISSED) return;
  const { id, ...fields } = saved;
  await prisma.agentCandidate.update({
    where: { id },
    data: {
      ...fields,
      reasons: (fields.reasons ?? []) as Prisma.InputJsonValue,
      redFlags: (fields.redFlags ?? []) as Prisma.InputJsonValue,
      status: AgentCandidateStatus.SCORED,
      error: null,
    },
  });
  await unmarkPosting(candidate, "dismissed");
}

/**
 * Restore from Claude (#221), which has no toast to undo from: a dismissed
 * candidate back in the queue, from what Find jobs keeps of its posting and
 * its score. A draft it had stays deleted.
 */
export async function restoreDismissedCandidate(candidateId: string): Promise<void> {
  const candidate = await prisma.agentCandidate.findUnique({ where: { id: candidateId }, select: { status: true, source: true, externalId: true } });
  if (!candidate) throw new ActionError("That posting is no longer in the agent's queue.");
  if (candidate.status !== AgentCandidateStatus.DISMISSED) throw new ActionError("That posting isn't dismissed.");
  const where = { source_externalId: { source: candidate.source, externalId: candidate.externalId } };
  // Scores are kept per profile (E25-5): the reasons of the one it fits best, as the candidate kept.
  const profileId = await bestProfileFor(candidate);
  const [posting, score] = await Promise.all([
    prisma.posting.findUnique({ where }),
    profileId ? prisma.postingScore.findUnique({ where: { source_externalId_profileId: { source: candidate.source, externalId: candidate.externalId, profileId } } }) : null,
  ]);
  if (!posting) throw new ActionError("Dossier no longer keeps that posting's details, so it can't come back.");
  await restoreCandidate({
    id: candidateId,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary,
    postedAt: posting.postedAt,
    // Shown as a link again: only a web address.
    url: safeLink(posting.url),
    via: posting.via,
    description: posting.description,
    complete: posting.complete,
    reasons: stringsOf(score?.reasons ?? null),
    redFlags: stringsOf(score?.redFlags ?? null),
  });
}
