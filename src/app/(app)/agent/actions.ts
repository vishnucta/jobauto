"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { approveCandidate, dismissCandidate, restoreCandidate, startCandidateDraft } from "@/lib/agent/draft";
import { startAgentRun } from "@/lib/agent/jobs";
import { agentSearchInputSchema } from "@/lib/agent/search";
import { deleteAgentSearch, listAgentSearches, moveAgentSearch, saveAgentSearch, setAgentSearchEnabled } from "@/lib/agent/searches";
import { agentSettingsChangeSchema, updateAgentSettings } from "@/lib/agent/settings";
import { action, ActionError } from "@/lib/action";
import { safeLink } from "@/lib/job-search/search";

// The Agent screen's actions (E16). Nothing here ever sends anything:
// approving only makes a draft a normal Draft application.

/**
 * Shared settings save at once. Search edits use the collection actions below.
 */
export const saveAgentSettings = action(agentSettingsChangeSchema, async (changes) => {
  await updateAgentSettings(changes);
  revalidatePath("/agent");
  revalidatePath("/settings");
  return null;
});

const searchId = z.string().min(1).max(100);
export const setRecurringSearchEnabled = action(z.object({ id: searchId, enabled: z.boolean() }).strict(), async ({ id, enabled }) => {
  const search = await setAgentSearchEnabled(id, enabled);
  revalidatePath("/agent");
  revalidatePath("/settings");
  return search;
});
export const saveRecurringSearch = action(
  agentSearchInputSchema.extend({ id: searchId.optional() }).strict(),
  async ({ id, ...input }) => {
    if (input.enabled && !input.query.country) throw new ActionError(`Choose a country for “${input.name}”.`);
    const search = await saveAgentSearch(input, id);
    revalidatePath("/agent");
    revalidatePath("/settings");
    return search;
  },
);
export const deleteRecurringSearch = action(z.object({ id: searchId }).strict(), async ({ id }) => {
  await deleteAgentSearch(id);
  revalidatePath("/agent");
  revalidatePath("/settings");
  return null;
});
export const moveRecurringSearch = action(z.object({ id: searchId, direction: z.enum(["up", "down"]) }).strict(), async ({ id, direction }) => {
  await moveAgentSearch(id, direction);
  revalidatePath("/agent");
  revalidatePath("/settings");
  return listAgentSearches();
});

/**
 * Run all now: at most once an hour after the previous run and only when
 * the whole enabled batch fits the rolling request quota. An unfinished job is
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
 * Prepare it for me on the Agent screen (E16-5): writes a candidate's draft
 * in the background. A draft under way is reused, and one already made (by
 * the agent, on Positions or from the same link) is answered with.
 */
export const prepareAgentDraft = action(z.object({ candidateId }), async ({ candidateId }) => {
  const { jobId, applicationId, started } = await startCandidateDraft(candidateId);
  if (started) revalidatePath("/agent");
  // One made already was taken as this posting's (one application per posting): it's in Applications now.
  else if (applicationId) revalidateAgent();
  return { jobId, applicationId, started };
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
