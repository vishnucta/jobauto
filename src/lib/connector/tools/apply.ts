import "server-only";

import { z } from "zod";

import type { ApplyAttemptStatus } from "@/generated/prisma/enums";
import { applyAnswersSchema, LANGUAGE_LEVEL_ANSWERS, type ApplyAnswers } from "@/lib/apply/answers";
import { resolveAttempt } from "@/lib/apply/run";
import { startApplyRun } from "@/lib/apply/start";
import { OPEN_ATTEMPT_STATUSES, type ApplyAttemptView, type ApplyPlanView } from "@/lib/apply/view";
import { loadApplyTab } from "@/lib/apply/view-data";
import { applyJob, applyJobKey } from "@/lib/jobs/apply";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { failure, started, text, type ToolContext } from "../kit";

// The Apply tab: filling the employer's form in a browser window (jobauto fork).
// Claude reads where the form is and how the runs went, starts a run, settles
// one by the user's word and saves the standard answers. A run Claude starts
// leaves Send to the user: she checks the window and presses it herself.

/** How a run stands, in the Apply tab's words ("Waiting for you" said of the user). */
const RUN_STATUS: Record<ApplyAttemptStatus, string> = {
  OPENING: "Working on it",
  WAITING: "Waiting for the user",
  SUBMITTED: "Sent",
  ABANDONED: "Not sent",
  FAILED: "Didn't work",
};

const FILLING = "Still filling in the form: follow running_task_id with check_task.";
const WATCHING =
  "Waiting for the user to check the browser window and press Send. Dossier notices the confirmation itself; if the user tells you how it ended, record it with settle_apply.";
const NOT_WATCHING = "Dossier isn't watching the browser window any more (it was restarted). Ask the user whether they sent it, then record it with settle_apply.";

/** An answer the AI wrote can be long; Claude gets its start. */
const VALUE_SHOWN = 300;
const shorten = (value: string) => (value.length > VALUE_SHOWN ? `${value.slice(0, VALUE_SHOWN)}…` : value);

/** The standard answers, with whether a street and postal code are saved but not what they are. */
function answersView(answers: ApplyAnswers) {
  return {
    salary: answers.salary,
    start_date: answers.startDate,
    notice_period: answers.noticePeriod,
    street_saved: answers.street.trim() !== "",
    postal_code_saved: answers.postalCode.trim() !== "",
    work_permit: answers.workPermit,
    german_level: answers.germanLevel,
    english_level: answers.englishLevel,
    press_send: answers.autoSubmit,
  };
}

/** Where the application's form is. */
function formView(plan: ApplyPlanView) {
  switch (plan.kind) {
    case "web":
      return { where: "web page", url: plan.url, host: plan.host, system: plan.atsLabel, sign_in_needed: plan.account, job_board: plan.board };
    case "email":
      return { where: "email", to: plan.to, next: "There's no form to fill: the posting asks for applications by email. The application's Email tab writes the email and sends it with the PDFs." };
    case "none":
      return {
        where: "none",
        next: "There's no link to apply at, and the posting names no email address. Add the posting's link on the Job posting tab, or apply by hand with the PDFs and mark it as sent.",
      };
  }
}

/** One run: how it went, what it filled in and what it left to the user. */
function runView(attempt: ApplyAttemptView, filling: boolean, linkTo: (path: string) => string) {
  const byAi = attempt.filled.filter((entry) => entry.byAi).length;
  return {
    run_id: attempt.id,
    status: RUN_STATUS[attempt.status],
    note: attempt.note || undefined,
    started: attempt.startedAt,
    page: attempt.host || undefined,
    filled: attempt.filled.map((entry) => ({ field: entry.label, filled_with: entry.what, value: shorten(entry.value) || undefined, by_ai: entry.byAi })),
    left_to_user: attempt.unfilled.map((entry) => ({ field: entry.label, required: entry.required, reason: entry.reason })),
    captcha: attempt.captcha || undefined,
    check_ai_answers:
      byAi > 0
        ? `Dossier's AI wrote ${byAi === 1 ? "an answer" : `${byAi} answers`} to the form's own questions: the user reads ${byAi === 1 ? "it" : "them"} in the browser window before sending.`
        : undefined,
    screenshot: attempt.screenshot ? linkTo(`/api/apply/${attempt.id}/filled`) : undefined,
    confirmation_screenshot: attempt.confirmation ? linkTo(`/api/apply/${attempt.id}/confirmation`) : undefined,
    next: !OPEN_ATTEMPT_STATUSES.includes(attempt.status) ? undefined : filling ? FILLING : attempt.watching ? WATCHING : NOT_WATCHING,
  };
}

/** Registers these tools on the connector's server. */
export function registerApplyTools({ server, linkTo }: ToolContext): void {
  const applyTab = (id: string) => linkTo(`/applications/${id}?tab=apply`);

  server.registerTool(
    "get_apply_status",
    {
      title: "Read an application's Apply tab",
      description:
        "Where an application's form is (a web page and its job system, an email address, or none), what the profile is missing for forms, the saved standard answers, " +
        "and the recent apply runs: what each filled in, what it left to the user and how it ended.",
      inputSchema: z.object({ id: z.string().min(1).max(100).describe("The application's id") }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const application = await prisma.application.findUnique({
        where: { id },
        select: { id: true, title: true, status: true, postingUrl: true, postingText: true, documents: { select: { kind: true } } },
      });
      if (!application) return failure("That application no longer exists.");
      const [profile, settings, timeZone] = await Promise.all([loadProfile(), loadSettings(), lastKnownTimeZone()]);
      const tab = await loadApplyTab(application, profile, settings, timeZone);
      return text({
        id: application.id,
        title: application.title,
        application_status: statusInfo(application.status).label,
        form: formView(tab.plan),
        has_resume: tab.hasResume,
        has_cover_letter: tab.hasLetter,
        profile_missing: tab.missing.length > 0 ? tab.missing : undefined,
        answers: answersView(tab.answers),
        running_task_id: tab.running ?? undefined,
        runs: tab.attempts.map((attempt) => runView(attempt, attempt.status === "OPENING" && tab.running !== null, linkTo)),
        link: applyTab(application.id),
      });
    },
  );

  server.registerTool(
    "start_apply",
    {
      title: "Fill in the employer's form",
      description:
        "Opens the employer's application form in a browser window on the computer running Dossier, fills it in from the profile and the standard answers, and attaches the PDFs. " +
        "It leaves Send to the user, who checks the window, finishes the form and presses Send there. Follow it with check_task, then get_apply_status.",
      inputSchema: z.object({ id: z.string().min(1).max(100).describe("The application's id") }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id }) => {
      // Whatever the standard answers say, a run Claude starts leaves Send to the user.
      const run = await startApplyRun(id, { mayPressSend: false });
      if (!run.ok) {
        if (run.problem !== "waiting") return failure(run.message);
        return failure(
          `Dossier is still waiting for the user on the last run (run_id ${run.attemptId}): they finish it in the browser window. If they tell you whether they sent it, record that with settle_apply, then start again.`,
        );
      }
      // A run that was already going may have been started on the Apply tab, where the user can let runs press Send.
      const followed = run.alreadyRunning && run.attemptId ? await prisma.applyAttempt.findUnique({ where: { id: run.attemptId }, select: { autoSubmit: true } }) : null;
      return started(run.jobId, {
        run_id: run.attemptId ?? undefined,
        already_running: run.alreadyRunning || undefined,
        presses_send: followed?.autoSubmit
          ? "This run was already going, started on the Apply tab, where the user lets runs press Send on simple job systems when nothing is left to fill."
          : undefined,
        link: applyTab(id),
        afterwards: "Once it's done, get_apply_status shows what was filled in and what's left. The user checks the browser window and presses Send there.",
      });
    },
  );

  server.registerTool(
    "settle_apply",
    {
      title: "Record whether a run was sent",
      description:
        "Records the user's word on an apply run that hasn't ended: that it was sent, which moves a draft application to Sent, or that it wasn't. Use it only after the user said which.",
      inputSchema: z.object({
        run_id: z.string().min(1).max(100).describe("The run, from get_apply_status or start_apply"),
        sent: z.boolean().describe("Whether the user sent the application"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ run_id, sent }) => {
      const attempt = await prisma.applyAttempt.findUnique({ where: { id: run_id }, select: { applicationId: true, status: true } });
      if (!attempt) return failure("That run no longer exists.");
      // The Apply tab offers this only on a run that hasn't ended, once it has stopped filling in the form.
      if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status)) {
        return failure(`That run already ended: ${RUN_STATUS[attempt.status]}. To change the application's status, use set_application_status.`);
      }
      const jobs = await findUnfinishedJobs(applyJobKey(attempt.applicationId));
      if (jobs.some((job) => applyJob.input.safeParse(job.input).data?.attemptId === run_id)) {
        return failure("That run is still filling in the form. Once check_task says it's done, the user can say whether they sent it.");
      }
      if (!(await resolveAttempt(run_id, sent))) return failure("That run ended just now. get_apply_status shows how.");
      const application = await prisma.application.findUnique({ where: { id: attempt.applicationId }, select: { status: true } });
      return text({
        run_id,
        status: sent ? RUN_STATUS.SUBMITTED : RUN_STATUS.ABANDONED,
        application_id: attempt.applicationId,
        application_status: application ? statusInfo(application.status).label : undefined,
        link: applyTab(attempt.applicationId),
      });
    },
  );

  server.registerTool(
    "save_apply_answers",
    {
      title: "Save the standard answers",
      description:
        "Saves the answers employers' forms ask for and the profile doesn't hold, used on every form. Only the answers given change; an empty one leaves that field to the user.",
      inputSchema: z.object({
        salary: z.string().trim().max(80).optional().describe("Salary expectation, e.g. '55.000 € brutto/Jahr'"),
        start_date: z.string().trim().max(80).optional().describe("Earliest start: 'sofort', or a day as YYYY-MM-DD"),
        notice_period: z.string().trim().max(80).optional().describe("e.g. 'keine' or '3 Monate zum Monatsende'"),
        street: z.string().trim().max(120).optional().describe("Street and number, when the profile's address line doesn't split cleanly"),
        postal_code: z.string().trim().max(12).optional(),
        work_permit: z.boolean().optional().describe("Allowed to work in Germany without sponsorship"),
        german_level: z.enum(LANGUAGE_LEVEL_ANSWERS).optional(),
        english_level: z.enum(LANGUAGE_LEVEL_ANSWERS).optional(),
        press_send: z
          .boolean()
          .optional()
          .describe(
            "Let runs started on Dossier's Apply tab press Send on simple job systems (Personio, Greenhouse, Lever, JOIN and a few more) when nothing is left to fill. Runs started from Claude never do. Change it only when the user asks.",
          ),
        id: z.string().min(1).max(100).optional().describe("An application, to link to its Apply tab"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, ...input }) => {
      const given: Partial<ApplyAnswers> = {
        salary: input.salary,
        startDate: input.start_date,
        noticePeriod: input.notice_period,
        street: input.street,
        postalCode: input.postal_code,
        workPermit: input.work_permit,
        germanLevel: input.german_level,
        englishLevel: input.english_level,
        autoSubmit: input.press_send,
      };
      const changes = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
      if (Object.keys(changes).length === 0) return failure("Give at least one answer to save.");
      const answers = applyAnswersSchema.parse({ ...(await loadSettings()).applyAnswers, ...changes });
      await saveSettings({ applyAnswers: answers });
      return text({
        answers: answersView(answers),
        note: answers.autoSubmit ? "Runs started on the Apply tab may press Send on simple job systems; runs started from Claude never do." : undefined,
        link: id ? applyTab(id) : linkTo("/applications"),
      });
    },
  );
}
