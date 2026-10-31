"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { approveCandidate, dismissCandidate, restoreCandidate, startCandidateDraft } from "@/lib/agent/draft";
import { startAgentRun } from "@/lib/agent/jobs";
import { agentSettingsChangeSchema, updateAgentSettings } from "@/lib/agent/settings";
import { action } from "@/lib/action";
import { safeLink } from "@/lib/job-search/search";

// The Agent screen's actions (E16). Nothing here ever sends anything:
// approving only makes a draft a normal Draft application.

/**
 * Settings → Job agent (E16-7): each change saves at once. Turning the agent
 * on needs a search with keywords and a country.
 */
export const saveAgentSettings = action(agentSettingsChangeSchema, async (changes) => {
  await updateAgentSettings(changes);
  revalidatePath("/agent");
  return null;
});

/**
 * Run now (E16-4): one more run, at most once an hour after the previous
 * one and within the daily limit. A run already queued or running is
 * reused rather than started again.
 */
export const runAgentNow = action(z.object({}), async () => {
  const run = await startAgentRun();
  if (!run.reused) revalidatePath("/agent");
  return run;
});

const candidateId = z.string().min(1).max(100);

/** Every screen an agent draft shows on, or leaves. */
function revalidateAgent() {
  revalidatePath("/agent");
  revalidatePath("/applications");
  revalidatePath("/jobs");
  revalidatePath("/");
}

/**
 * Prepare draft (E16-5): writes a candidate's draft in the background. A
 * draft under way is reused, and one already made is answered with.
 */
export const prepareAgentDraft = action(z.object({ candidateId }), async ({ candidateId }) => {
  const { jobId, applicationId, started } = await startCandidateDraft(candidateId);
  if (started) revalidatePath("/agent");
  return { jobId, applicationId };
});

/** Approve (E16-5): the draft joins Applications as a Draft. Nothing is sent. */
export const approveAgentDraft = action(z.object({ candidateId }), async ({ candidateId }, { toast }) => {
  const applicationId = await approveCandidate(candidateId);
  revalidateAgent();
  toast("Added to Applications as a draft. Nothing has been sent.");
  return { applicationId };
});

/**
 * Dismiss (E16-5): the posting never comes back; its draft, if any, is
 * deleted. A posting dismissed before it had a draft can be put back.
 */
export const dismissAgentCandidate = action(z.object({ candidateId }), async ({ candidateId }) => {
  const { undo } = await dismissCandidate(candidateId);
  revalidateAgent();
  return { undo };
});

/** Undo on a dismissed posting's toast. */
export const restoreAgentCandidate = action(
  z.object({
    id: candidateId,
    place: z.string().max(500),
    remote: z.boolean().nullable(),
    salary: z.string().max(500),
    postedAt: z.coerce.date().nullable(),
    // Shown as a link again: only a web address.
    url: z.string().max(4000).transform(safeLink),
    via: z.string().max(500),
    description: z.string().max(200_000),
    complete: z.boolean(),
    reasons: z.array(z.string().max(500)).max(10).nullable(),
    redFlags: z.array(z.string().max(500)).max(10).nullable(),
  }),
  async (saved) => {
    await restoreCandidate(saved);
    revalidateAgent();
    return null;
  },
);
