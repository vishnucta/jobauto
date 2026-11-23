import "server-only";

import { z } from "zod";

import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { draftJobKey } from "@/lib/agent/draft";
import { planFor } from "@/lib/apply/plan";
import { fullText } from "@/lib/job-search/find";
import { postingText } from "@/lib/job-search/search";
import { logServerError } from "@/lib/log";
import { keptApplication, prepareJobKey } from "@/lib/posting-application";
import { bestProfileFor } from "@/lib/posting-scores";
import { foundFromPosting, storePosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { openProfileId } from "@/lib/profiles";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";
import { writeApplication } from "./write-application";
import { writeEmailJob } from "./write-email";

// "Prepare it for me" on Positions (jobauto fork): one click instead of
// New application's steps. In the background the posting is read,
// the documents are written the way the agent writes its drafts
// (write-application.ts), the application is created as a Draft, and, when
// the employer takes applications by email, the email is written too. She
// reads it when it's ready; nothing is sent.

export { prepareJobKey };

type PostingRef = { id: string; source: string; externalId: string; url: string };

/**
 * What the job agent or another button made for this posting already (one
 * application per posting, audit round 2): the agent's draft for it, which
 * stays the agent's to approve, the job agent writing one, or an
 * application from the same link, which Positions then keeps with it.
 */
async function madeElsewhere(posting: PostingRef): Promise<{ applicationId: string | null; jobId: string | null }> {
  const candidate = await prisma.agentCandidate.findUnique({
    where: { source_externalId: { source: posting.source, externalId: posting.externalId } },
    select: { id: true, status: true, applicationId: true },
  });
  if (candidate?.applicationId && (candidate.status === AgentCandidateStatus.DRAFTED || candidate.status === AgentCandidateStatus.APPROVED)) {
    return { applicationId: candidate.applicationId, jobId: null };
  }
  if (candidate?.status === AgentCandidateStatus.DRAFTING) {
    const [drafting] = await findUnfinishedJobs(draftJobKey(candidate.id));
    if (drafting) return { applicationId: null, jobId: drafting.id };
  }
  const kept = await keptApplication(posting);
  // Kept with the posting from now on, unless another posting (the same job on another portal) has it.
  if (kept && !(await prisma.posting.findUnique({ where: { applicationId: kept }, select: { id: true } }))) {
    await prisma.posting.updateMany({ where: { id: posting.id, applicationId: null }, data: { applicationId: kept } });
  }
  return { applicationId: kept, jobId: null };
}

export const prepareApplicationJob = defineJob({
  type: "prepare-application",
  input: z.object({
    postingId: z.string().min(1),
    /** The profile to write it from, when Claude names one (draft_application); else the one that fits it best. */
    profileId: z.string().min(1).nullable().default(null),
    /** What the documents should stress, in the user's words (draft_application). */
    note: z.string().max(2000).default(""),
  }),
  result: z.object({
    applicationId: z.string().min(1),
    /** How it's sent: the employer's form, an email, or by hand. */
    route: z.enum(["web", "email", "none"]),
  }),
  async run({ postingId, profileId: asked, note }, context) {
    const posting = await prisma.posting.findUnique({ where: { id: postingId } });
    if (!posting) throw new ActionError("That posting is no longer kept. Find it again and prepare it from there.");
    const text = postingText(posting);
    const plan = planFor({ postingUrl: posting.url, postingText: text, posting: { url: posting.url, source: posting.source }, company: posting.company });
    // Prepared already, e.g. by a first run that was retried, or by the job agent meanwhile: the same application.
    if (posting.applicationId) return { applicationId: posting.applicationId, route: plan.kind };
    const elsewhere = await madeElsewhere(posting);
    if (elsewhere.applicationId) return { applicationId: elsewhere.applicationId, route: plan.kind };
    if (elsewhere.jobId) throw new ActionError("The job agent is writing this posting's draft already. It's on the Agent screen when it's ready.");
    if (!posting.description.trim()) throw new ActionError("That posting has no text to write from. Open it and start the application step by step, with its text pasted in.");

    // From the profile that fits it best, as New application from Positions starts with (M8); else the one last opened (E24-6).
    // Its kept score for that profile answers How you match with no new call (E25-7).
    const profileId = asked ?? (await bestProfileFor(posting)) ?? (await openProfileId());
    const applicationId = await writeApplication(
      {
        posting: text,
        postingUrl: posting.url,
        name: posting.company || posting.title || "the posting",
        claim: { kind: "prepare", postingId },
        profileId,
        scored: { source: posting.source, externalId: posting.externalId },
        note,
      },
      context,
    );

    // Out of the job agent's queue: the posting has its application (adoptApplication does the same the other way).
    await prisma.agentCandidate.updateMany({
      where: { source: posting.source, externalId: posting.externalId, status: AgentCandidateStatus.SCORED, applicationId: null },
      data: { status: AgentCandidateStatus.APPROVED, applicationId },
    });

    // An employer that takes applications by email gets the email written too: one wait less.
    if (plan.kind === "email" && !context.signal.aborted) {
      try {
        await writeEmailJob.run({ applicationId, to: plan.to }, context);
      } catch (error) {
        // The application is ready all the same; the Email tab writes it on request.
        if (!context.signal.aborted) logServerError("prepare application: email", error);
      }
    }
    return { applicationId, route: plan.kind };
  },
});

/**
 * Starts preparing a posting's application; one under way is followed, and
 * one made already (here, by the job agent, or from the same link) is
 * answered with. Positions' button and the connector's draft_application
 * both start it here, so a posting gets one application.
 */
export async function startPreparing(
  postingId: string,
  { profileId = null, note = "" }: { profileId?: string | null; note?: string } = {},
): Promise<{ jobId: string | null; applicationId: string | null }> {
  const existing = await postingApplication(postingId);
  if (existing.applicationId || existing.jobId) return existing;
  return { jobId: await startJob(prepareApplicationJob, { postingId, profileId, note }, { key: prepareJobKey(postingId) }), applicationId: null };
}

/**
 * Prepare, for a posting Positions keeps, by its id: the dashboard's row for
 * a posting in her field (jobauto fork, today.ts). As Positions' button
 * does, its whole text is asked for first when its portal sent only the
 * start of it, so the documents aren't written from a snippet.
 */
export async function prepareKept(postingId: string): Promise<{ jobId: string | null; applicationId: string | null }> {
  const row = await prisma.posting.findUnique({ where: { id: postingId } });
  if (!row) throw new ActionError("That posting is no longer kept. Find it again and prepare it from there.");
  const posting = foundFromPosting(row);
  if (!posting.complete) {
    const text = await fullText(posting);
    if (text) await storePosting({ ...posting, description: text, complete: true });
  }
  return startPreparing(postingId);
}

/**
 * The application a kept posting has, or the task writing one, before
 * anything writes another: Prepare it for me, and save_application with
 * what Claude wrote. Both null when it has neither.
 */
export async function postingApplication(postingId: string): Promise<{ jobId: string | null; applicationId: string | null }> {
  const posting = await prisma.posting.findUnique({ where: { id: postingId }, select: { id: true, source: true, externalId: true, url: true, applicationId: true } });
  if (!posting) throw new ActionError("That posting is no longer kept. Find it again and prepare it from there.");
  if (posting.applicationId) return { jobId: null, applicationId: posting.applicationId };
  const [unfinished] = await findUnfinishedJobs(prepareJobKey(postingId));
  if (unfinished) return { jobId: unfinished.id, applicationId: null };
  // Made by the job agent or from the same link: answered with, or followed while the agent writes it.
  return madeElsewhere(posting);
}
