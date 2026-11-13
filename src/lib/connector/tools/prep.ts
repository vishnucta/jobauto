import "server-only";

import { z } from "zod";

import { isAiUsable } from "@/lib/ai/config";
import { callPrepOf, FALLBACK, SAY_AGAIN } from "@/lib/call-prep";
import { startCallPrep } from "@/lib/jobs/prepare-call";
import { prisma } from "@/lib/prisma";

import { failure, started, text, type ToolContext } from "../kit";

// Call prep, an application's tab (jobauto fork): the phone-screen prep pack
// with her answers in German at her level and in English. Claude can read it
// to rehearse with her, or have Dossier prepare it.

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
}
