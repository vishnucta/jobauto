import "server-only";

import { ApplyAttemptStatus, DocumentKind } from "@/generated/prisma/enums";
import { applyJob, applyJobKey } from "@/lib/jobs/apply";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";

import { planFor } from "./plan";
import { isWatching } from "./watches";

// Starting a run of the apply assistant (Phase A): "Open and fill it in" on
// the Apply tab, and start_apply in the Claude connector. Both make the same
// checks; whether the run may press Send is the caller's to say.

/** Why a run didn't start; the message is written for the Apply tab. */
export type ApplyStartProblem =
  | { ok: false; problem: "gone" | "no-link" | "no-resume"; message: string }
  | { ok: false; problem: "email"; to: string; message: string }
  | { ok: false; problem: "waiting"; attemptId: string; message: string };

export type ApplyStart =
  | {
      ok: true;
      jobId: string;
      attemptId: string | null;
      /** A run was already going: this is that run, and nothing new started. */
      alreadyRunning: boolean;
    }
  | ApplyStartProblem;

/**
 * Starts the apply assistant for an application and returns the job to
 * follow. Asking again while a run is going follows that run; a run still
 * waiting for the user has to be settled first. Without `mayPressSend` the
 * run leaves Send to the user, whatever the standard answers say.
 */
export async function startApplyRun(id: string, { mayPressSend }: { mayPressSend: boolean }): Promise<ApplyStart> {
  const application = await prisma.application.findUnique({
    where: { id },
    select: { postingUrl: true, postingText: true, documents: { select: { kind: true } }, posting: { select: { url: true, source: true } } },
  });
  if (!application) return { ok: false, problem: "gone", message: "That application no longer exists." };
  const plan = planFor(application);
  if (plan.kind === "email") return { ok: false, problem: "email", to: plan.to, message: `This posting asks for applications by email (${plan.to}). Use the Email tab.` };
  if (plan.kind === "none") return { ok: false, problem: "no-link", message: "There's no link to apply at. Add the posting's link on the Job posting tab first." };
  if (!application.documents.some((document) => document.kind === DocumentKind.RESUME)) return { ok: false, problem: "no-resume", message: "This application has no resume to attach yet." };

  const [running] = await findUnfinishedJobs(applyJobKey(id));
  if (running) {
    const input = applyJob.input.safeParse(running.input);
    return { ok: true, jobId: running.id, attemptId: input.success ? input.data.attemptId : null, alreadyRunning: true };
  }
  const open = await prisma.applyAttempt.findFirst({
    where: { applicationId: id, status: { in: [ApplyAttemptStatus.OPENING, ApplyAttemptStatus.WAITING] } },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  if (open && isWatching(open.id)) {
    return {
      ok: false,
      problem: "waiting",
      attemptId: open.id,
      message: "I'm still waiting for you on the last run. Finish it in the browser window, or say below whether you sent it.",
    };
  }
  // Left over from before a restart: nothing watches it any more.
  if (open) await prisma.applyAttempt.update({ where: { id: open.id }, data: { status: ApplyAttemptStatus.ABANDONED, note: "A new run replaced this one.", finishedAt: new Date() } });

  const settings = await loadSettings();
  const attempt = await prisma.applyAttempt.create({
    data: { applicationId: id, url: plan.url, ats: plan.ats.id, autoSubmit: mayPressSend && settings.applyAnswers.autoSubmit && plan.ats.autoSubmit },
    select: { id: true },
  });
  const jobId = await startJob(applyJob, { applicationId: id, attemptId: attempt.id }, { key: applyJobKey(id), applicationId: id });
  return { ok: true, jobId, attemptId: attempt.id, alreadyRunning: false };
}
