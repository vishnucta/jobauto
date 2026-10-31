"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { applyAnswersSchema } from "@/lib/apply/answers";
import { resolveAttempt } from "@/lib/apply/run";
import { startApplyRun } from "@/lib/apply/start";
import { prisma } from "@/lib/prisma";
import { saveSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";

// The Apply tab's actions (Phase A): start a run in the browser, save the
// standard answers, and settle a run by the user's word.

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

/** The standard answers on the Apply tab, saved for every application. */
export const saveApplyAnswers = action(z.object({ id: z.string().min(1), answers: applyAnswersSchema }), async ({ id, answers }, { toast }) => {
  await saveSettings({ applyAnswers: answers });
  refresh(id);
  toast("Saved. I'll use these answers on every form.");
  return null;
});

/** "I sent it" / "I didn't send it": settles a run the page couldn't read the end of. */
export const settleApplyAttempt = action(z.object({ attemptId: z.string().min(1), sent: z.boolean() }), async ({ attemptId, sent }, { toast }) => {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId }, select: { applicationId: true } });
  if (!attempt) throw new ActionError("That run no longer exists.");
  const settled = await resolveAttempt(attemptId, sent);
  refresh(attempt.applicationId);
  // It ended since the tab was loaded, e.g. the page confirmed it: it keeps how it ended.
  if (!settled) throw new ActionError("That run already ended.");
  toast(sent ? `Marked as sent. ${statusInfo(ApplicationStatus.SENT).toast}` : "Noted: nothing was sent.");
  return null;
});
