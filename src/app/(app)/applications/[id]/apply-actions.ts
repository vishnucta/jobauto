"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus, ApplyAttemptStatus, DocumentKind } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { applyAnswersSchema } from "@/lib/apply/answers";
import { planFor } from "@/lib/apply/plan";
import { isWatching, resolveAttempt } from "@/lib/apply/run";
import { applyJob, applyJobKey } from "@/lib/jobs/apply";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";

// The Apply tab's actions (Phase A): start a run in the browser, save the
// standard answers, and settle a run by the user's word.

const GONE = "That application no longer exists.";
const refresh = (id: string) => revalidatePath(`/applications/${id}`);

/**
 * "Open and fill it in": starts the apply assistant for an application and
 * returns the job to follow. Asking again while a run is going follows
 * that run; a run still waiting for the user has to be settled first.
 */
export const startApply = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const application = await prisma.application.findUnique({
    where: { id },
    select: { postingUrl: true, postingText: true, documents: { select: { kind: true } }, posting: { select: { url: true, source: true } } },
  });
  if (!application) throw new ActionError(GONE);
  const plan = planFor(application);
  if (plan.kind === "email") throw new ActionError(`This posting asks for applications by email (${plan.to}). Use the Email tab.`);
  if (plan.kind === "none") throw new ActionError("There's no link to apply at. Add the posting's link on the Job posting tab first.");
  if (!application.documents.some((document) => document.kind === DocumentKind.RESUME)) throw new ActionError("This application has no resume to attach yet.");

  const [running] = await findUnfinishedJobs(applyJobKey(id));
  if (running) {
    const input = applyJob.input.safeParse(running.input);
    return { jobId: running.id, attemptId: input.success ? input.data.attemptId : null };
  }
  const open = await prisma.applyAttempt.findFirst({
    where: { applicationId: id, status: { in: [ApplyAttemptStatus.OPENING, ApplyAttemptStatus.WAITING] } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (open && isWatching(open.id)) {
    throw new ActionError("I'm still waiting for you on the last run. Finish it in the browser window, or say below whether you sent it.");
  }
  // Left over from before a restart: nothing watches it any more.
  if (open) await prisma.applyAttempt.update({ where: { id: open.id }, data: { status: ApplyAttemptStatus.ABANDONED, note: "A new run replaced this one.", finishedAt: new Date() } });

  const settings = await loadSettings();
  const attempt = await prisma.applyAttempt.create({
    data: { applicationId: id, url: plan.url, ats: plan.ats.id, autoSubmit: settings.applyAnswers.autoSubmit && plan.ats.autoSubmit },
    select: { id: true },
  });
  const jobId = await startJob(applyJob, { applicationId: id, attemptId: attempt.id }, { key: applyJobKey(id), applicationId: id });
  refresh(id);
  return { jobId, attemptId: attempt.id };
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
  await resolveAttempt(attemptId, sent);
  refresh(attempt.applicationId);
  toast(sent ? `Marked as sent. ${statusInfo(ApplicationStatus.SENT).toast}` : "Noted: nothing was sent.");
  return null;
});
