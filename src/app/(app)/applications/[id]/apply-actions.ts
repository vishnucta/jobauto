"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { newRouteLine, setPostingLink } from "@/lib/apply/posting-link";
import { resolveAttempt } from "@/lib/apply/run";
import { startApplyRun, startFillPage } from "@/lib/apply/start";
import { prisma } from "@/lib/prisma";
import { statusInfo } from "@/lib/status";

// The Apply tab's actions (Phase A): start a run in the browser and settle
// a run by the user's word. The standard answers and where the browser
// window opens are saved in Settings → Standard answers (jobauto fork).

const refresh = (id: string) => revalidatePath(`/applications/${id}`);

/**
 * "Open and fill it in": starts the apply assistant for an application and
 * returns the job to follow (src/lib/apply/start.ts). A run started here
 * may press Send where the standard answers allow it.
 */
export const startApply = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const started = await startApplyRun(id, { mayPressSend: true });
  if (!started.ok) throw new ActionError(started.message);
  if (!started.alreadyRunning) refresh(id);
  return { jobId: started.jobId, attemptId: started.attemptId };
});

/**
 * "Fill this page": fills the page the user is looking at, in the window of the run
 * that is waiting for her, and returns the job to follow (src/lib/apply/start.ts).
 * She has got past a login, a bot check or a step of the form herself; Send stays hers.
 */
export const fillThisPage = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const started = await startFillPage(id);
  if (!started.ok) throw new ActionError(started.message);
  if (!started.alreadyRunning) refresh(id);
  return { jobId: started.jobId, attemptId: started.attemptId };
});

/**
 * "Use this link": the employer's own posting for an application whose link
 * is a copy of the ad (src/lib/apply/posting-link.ts). The way to send it is
 * worked out again from the new link.
 */
export const savePostingLink = action(z.object({ id: z.string().min(1), link: z.string().max(4000) }), async ({ id, link }, { toast }) => {
  const plan = await setPostingLink(id, link);
  refresh(id);
  toast(`Link saved. ${newRouteLine(plan)}`);
  return { route: plan.kind };
});

/** "I sent it" / "I didn't send it": settles a run the page couldn't read the end of. */
export const settleApplyAttempt = action(z.object({ attemptId: z.string().min(1), sent: z.boolean() }), async ({ attemptId, sent }, { toast }) => {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId }, select: { applicationId: true } });
  if (!attempt) throw new ActionError("That run no longer exists.");
  const settled = await resolveAttempt(attemptId, sent);
  // Sent moves its status, and the sidebar and dashboard count those: every page is refreshed, as for any status change.
  if (sent && settled) revalidatePath("/", "layout");
  else refresh(attempt.applicationId);
  // It ended since the tab was loaded, e.g. the page confirmed it: it keeps how it ended.
  if (!settled) throw new ActionError("That run already ended.");
  toast(sent ? `Marked as sent. ${statusInfo(ApplicationStatus.SENT).toast}` : "Noted: nothing was sent.");
  return null;
});
