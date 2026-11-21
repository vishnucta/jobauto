import "server-only";

import { z } from "zod";

import { isAiUsable } from "@/lib/ai/config";
import { callPrepOf, FALLBACK, SAY_AGAIN } from "@/lib/call-prep";
import { startCallPrep } from "@/lib/jobs/prepare-call";
import { PRACTICE_JOB_KEY, startPractice } from "@/lib/jobs/prepare-practice";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { describeGuide, MIN_POSTINGS } from "@/lib/salary-guide";
import { loadSalaryGuide } from "@/lib/salary-guide-data";
import { loadSettings } from "@/lib/settings-data";

import { failure, started, text, type ToolContext } from "../kit";

// Call prep, an application's tab (jobauto fork): the phone-screen prep pack
// with her answers in German at her level and in English. Claude can read it
// to rehearse with her, or have Dossier prepare it. Call prep's general
// practice (/call-prep, once Interview practice) is the same pack before
// there's a call, from the profile alone; the salary guide
// is what fills the pack's salary line.

const id = z.string().min(1).max(100);

export function registerPrepTools({ server, linkTo }: ToolContext): void {
  server.registerTool(
    "get_call_prep",
    {
      title: "Get an application's call prep",
      description:
        "The phone-screen prep pack on an application's Call prep tab: the questions a first call in Germany asks, each with the user's answer in German she can say and in English, " +
        "a salary line with […] where she fills in the figure, stories from her roles, questions to ask, and what to decide first. Use it to rehearse the call with her.",
      inputSchema: z.object({ application_id: id }),
      annotations: { readOnlyHint: true },
    },
    async ({ application_id }) => {
      const application = await prisma.application.findUnique({ where: { id: application_id }, select: { id: true, prep: true, company: true } });
      if (!application) return failure("That application no longer exists.");
      const pack = callPrepOf(application.prep);
      const link = linkTo(`/applications/${application.id}?tab=prep`);
      if (!pack) return text({ prepared: false, message: "There's no prep pack yet. prepare_call prepares one.", link });
      return text({ prepared: true, company: application.company, when_german_runs_out: FALLBACK, to_hear_it_again: SAY_AGAIN, ...pack, link });
    },
  );

  server.registerTool(
    "prepare_call",
    {
      title: "Prepare for a call",
      description:
        "Has Dossier's AI prepare, or prepare again, an application's phone-screen pack, as Prepare for the call on its Call prep tab does; it's also prepared on its own when the application moves to Screening or Interview. " +
        "Answers with a task_id: follow it with check_task, then read the pack with get_call_prep.",
      inputSchema: z.object({ application_id: id }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ application_id }) => {
      if (!(await prisma.application.count({ where: { id: application_id } }))) return failure("That application no longer exists.");
      if (!(await isAiUsable())) return failure("Dossier has no AI provider set up (Settings → AI provider). You can write the pack with the user yourself instead.");
      const { jobId, reused } = await startCallPrep(application_id);
      return started(jobId, reused ? { note: "It was already being prepared: this is that task." } : {});
    },
  );

  server.registerTool(
    "get_practice_prep",
    {
      title: "Get the general practice pack",
      description:
        "Call prep's general practice pack: the call prep pack before there's a call, from the profile alone, for the kind of job the user is after, " +
        "with the same questions, answers in German and English, salary line, stories and questions to ask as get_call_prep. Use it to rehearse before any application has a call.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [settings, [preparing]] = await Promise.all([loadSettings(), findUnfinishedJobs(PRACTICE_JOB_KEY)]);
      const link = linkTo("/call-prep");
      // One being prepared again: its task, with the pack from before while there is one.
      const task = preparing ? { task_id: preparing.id, note: "A new pack is being prepared: check_task follows it." } : {};
      if (!settings.practicePrep) return text({ prepared: false, ...task, message: preparing ? undefined : "There's no practice pack yet. prepare_practice prepares one.", link });
      return text({ prepared: true, ...task, when_german_runs_out: FALLBACK, to_hear_it_again: SAY_AGAIN, ...settings.practicePrep, link });
    },
  );

  server.registerTool(
    "prepare_practice",
    {
      title: "Prepare general practice",
      description:
        "Has Dossier's AI prepare, or prepare again, Call prep's general practice pack from the profile, as Prepare my practice call does; the new pack replaces the one before. " +
        "Answers with a task_id: follow it with check_task, then read the pack with get_practice_prep.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => {
      if (!(await isAiUsable())) return failure("Dossier has no AI provider set up (Settings → AI provider). You can rehearse with the user from get_profile yourself instead.");
      const { jobId, reused } = await startPractice();
      return started(jobId, reused ? { note: "It was already being prepared: this is that task." } : {});
    },
  );

  server.registerTool(
    "get_salary_guide",
    {
      title: "Get the salary guide",
      description:
        "What the postings Dossier has seen pay for jobs like one, from the salaries they state, as the application's Apply tab shows it under the salary expectation: " +
        "the middle half of the yearly salaries and the middle, in euros. Give an application, a posting from list_postings, or a job title. " +
        "Use it to fill the […] in a call prep pack's salary line, with the user's say-so. Nothing is looked up outside Dossier.",
      inputSchema: z.object({
        application_id: z.string().min(1).max(100).optional(),
        posting_id: z.string().min(1).max(100).optional().describe("A posting from list_postings"),
        title: z.string().trim().min(1).max(200).optional().describe("A job title, e.g. 'Regulatory Reporting Analyst'"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ application_id, posting_id, title }) => {
      let jobTitle = title ?? "";
      let link = linkTo("/jobs");
      if (application_id) {
        const application = await prisma.application.findUnique({ where: { id: application_id }, select: { role: true, title: true } });
        if (!application) return failure("That application no longer exists.");
        // As the Apply tab asks it: the role, else the title.
        jobTitle = application.role || application.title;
        link = linkTo(`/applications/${application_id}?tab=apply`);
      } else if (posting_id) {
        const posting = await prisma.posting.findUnique({ where: { id: posting_id }, select: { title: true } });
        if (!posting) return failure("That posting is no longer in Dossier.");
        jobTitle = posting.title;
      }
      if (!jobTitle.trim()) return failure("Give application_id, posting_id or a job title.");
      const guide = await loadSalaryGuide(jobTitle);
      if (!guide) {
        return text({ title: jobTitle, guide: null, message: `Fewer than ${MIN_POSTINGS} postings Dossier has seen state a salary in euros, so there's no guide yet. It grows with every search.`, link });
      }
      return text({
        title: jobTitle,
        guide: describeGuide(guide),
        low: guide.low,
        high: guide.high,
        middle: guide.median,
        from_postings: guide.postings,
        basis: guide.basis === "alike" ? "jobs like this one" : "all the jobs seen, as too few like this one state a salary",
        link,
      });
    },
  );
}
