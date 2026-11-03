import "server-only";

import { z } from "zod";

import { DocumentKind, JobStatus } from "@/generated/prisma/enums";
import { agentDraftJob } from "@/lib/agent/draft";
import { agentScanJob } from "@/lib/agent/jobs";
import { matchScore } from "@/lib/application-data";
import { fitBand } from "@/lib/fit";
import { viewHref } from "@/lib/job-search/search";
import { applyJob } from "@/lib/jobs/apply";
import { draftReplyJob } from "@/lib/jobs/draft-reply";
import { importProfileJob } from "@/lib/jobs/import-profile";
import { readPostingJob } from "@/lib/jobs/read-posting";
import { refineJob } from "@/lib/jobs/refine";
import { regenerateUnitJob } from "@/lib/jobs/regenerate-unit";
import { translateDocumentsJob } from "@/lib/jobs/translate-documents";
import { cancelJob, isFinished, JOB_MESSAGES, retryJob } from "@/lib/jobs/runner";
import { scorePostingJob } from "@/lib/jobs/score-posting";
import { writeDocumentsJob } from "@/lib/jobs/write-documents";
import { writeEmailJob } from "@/lib/jobs/write-email";
import { zipPdfsJob } from "@/lib/jobs/zip-pdfs";
import { prisma } from "@/lib/prisma";
import { refreshStartupsJob } from "@/lib/startups/refresh";
import { STARTUP_SOURCE_INFO } from "@/lib/startups/types";

import { connectorDraftJob } from "../draft";
import { failure, started, text, type ToolContext } from "../kit";

// Background work started by other tools: its progress, cancelling and retrying (jobauto fork).
// Any task, whether a tool or a button on Dossier's screens started it. What
// came of one is told in ids, counts and links: never a document's text, or
// anyone's contact details.

/** A task as these tools read it: a row of the Job table. */
type Task = { id: string; type: string; status: JobStatus; step: string | null; error: string | null; input: unknown; result: unknown; applicationId: string | null };

/** What a task is, what it works on, what came of it and where the user sees it. */
type Told = { task: string; about?: Record<string, unknown>; result?: Record<string, unknown>; link?: string; next?: string };

type Tell = (task: Task, linkTo: (path: string) => string) => Told | Promise<Told>;

const TASK_FIELDS = { id: true, type: true, status: true, step: true, error: true, input: true, result: true, applicationId: true } as const;

/** An unknown task, or one the retention sweep deleted (src/lib/jobs/retention.ts). */
const NO_TASK = "There's no such task. Finished tasks are deleted after the time set in Settings → Your data.";

/** A reply draft that failed is drafted anew, not retried: no screen retries one, and the job saves its draft without checking the email. */
const DRAFT_AGAIN = "Draft it again with draft_email_reply, which checks the email first.";

const STATUS: Record<JobStatus, string> = { QUEUED: "queued", RUNNING: "working", DONE: "done", FAILED: "failed" };

/** The application's tab each document is on. */
const TAB: Record<DocumentKind, string> = { RESUME: "resume", COVER_LETTER: "letter", EMAIL: "email" };

/** A task's input, read with its kind's schema; null when it doesn't fit. */
function inputOf<I>(definition: { input: z.ZodType<I> }, task: Task): I | null {
  const parsed = definition.input.safeParse(task.input);
  return parsed.success ? parsed.data : null;
}

/** A task's result, read with its kind's schema; null until it's done, or when it doesn't fit. */
function resultOf<R>(definition: { result: z.ZodType<R> }, task: Task): R | null {
  if (task.status !== JobStatus.DONE) return null;
  const parsed = definition.result.safeParse(task.result);
  return parsed.success ? parsed.data : null;
}

/** A note without the email addresses in it: an employer's, but contact details all the same. */
const withoutAddresses = (note: string) => note.replace(/[^\s@()<>]+@[^\s@()<>]+\.[^\s@()<>]+/g, "address left out");

/** Every kind of task Dossier runs (src/lib/jobs/definitions.ts), by its type. */
const KINDS: Record<string, Tell> = {
  [readPostingJob.type]: (task, linkTo) => {
    const read = resultOf(readPostingJob, task);
    const matched = read && matchScore(read.match);
    return {
      task: "Reading a posting for New application",
      about: { application_id: task.applicationId ?? undefined },
      result: read && matched ? { company: read.extracted.company ?? undefined, role: read.extracted.role ?? undefined, matched: `${matched.hit} of ${matched.total} requirements` } : undefined,
      link: linkTo(task.applicationId ? `/applications/${task.applicationId}` : "/new"),
    };
  },
  [writeDocumentsJob.type]: (task, linkTo) => ({
    task: "Writing the resume and cover letter for New application",
    about: { application_id: task.applicationId ?? undefined },
    link: linkTo(task.applicationId ? `/applications/${task.applicationId}` : "/new"),
  }),
  [regenerateUnitJob.type]: (task, linkTo) => {
    const input = inputOf(regenerateUnitJob, task);
    const rewrite = resultOf(regenerateUnitJob, task);
    return {
      task: "Rewriting part of a document",
      about: { application_id: input?.applicationId },
      result: rewrite ? { outcome: rewrite.outcome === "rewritten" ? "Rewritten" : "Left as it was: it was edited meanwhile" } : undefined,
      link: input ? linkTo(`/applications/${input.applicationId}?tab=${TAB[input.document]}`) : undefined,
      next: rewrite ? "Read it with get_document." : undefined,
    };
  },
  [translateDocumentsJob.type]: (task, linkTo) => {
    const input = inputOf(translateDocumentsJob, task);
    const done = resultOf(translateDocumentsJob, task);
    return {
      task: input ? `Rewriting the documents in ${input.language}` : "Rewriting the documents in another language",
      about: { application_id: input?.applicationId },
      result: done ? { parts_rewritten: done.rewritten, parts_left_as_they_were: done.left.length } : undefined,
      link: input ? linkTo(`/applications/${input.applicationId}`) : undefined,
      next: done ? "Read them with get_document. The earlier text is in each document's versions." : undefined,
    };
  },
  [refineJob.type]: (task, linkTo) => {
    const input = inputOf(refineJob, task);
    const reply = resultOf(refineJob, task);
    return {
      task: "Answering in Refine with AI",
      about: { application_id: input?.applicationId },
      result: reply ? { parts_changed: reply.edited.length } : undefined,
      link: input ? linkTo(`/applications/${input.applicationId}`) : undefined,
      next: reply ? "Read the changes with get_document." : undefined,
    };
  },
  [writeEmailJob.type]: (task, linkTo) => {
    const input = inputOf(writeEmailJob, task);
    return {
      task: "Writing an application's email",
      about: { application_id: input?.applicationId },
      link: input ? linkTo(`/applications/${input.applicationId}?tab=email`) : undefined,
      next: task.status === JobStatus.DONE ? "Read it with get_document, document email." : undefined,
    };
  },
  [zipPdfsJob.type]: (task, linkTo) => {
    const zip = resultOf(zipPdfsJob, task);
    return {
      task: "Zipping every application's PDFs",
      result: zip ? { documents: zip.documents, file_name: zip.fileName } : undefined,
      link: linkTo(zip ? `/api/downloads/${task.id}` : "/settings"),
      next: zip ? "The link downloads the zip once, in a browser signed in to Dossier." : undefined,
    };
  },
  [importProfileJob.type]: (task, linkTo) => ({
    task: "Reading a resume for the profile",
    link: linkTo(`/profile/import?job=${task.id}`),
    next: task.status === JobStatus.DONE ? "Nothing is in the profile yet. Show the user what was read with finish_profile_import." : undefined,
  }),
  [draftReplyJob.type]: (task, linkTo) => {
    const input = inputOf(draftReplyJob, task);
    const reply = resultOf(draftReplyJob, task);
    return {
      task: "Drafting an answer to an employer's email",
      about: { email_id: input?.emailId },
      result: reply && reply.slots.length > 0 ? { offered_times: reply.slots } : undefined,
      link: linkTo("/inbox"),
    };
  },
  [agentScanJob.type]: (task, linkTo) => ({ task: "Running the job agent", result: resultOf(agentScanJob, task) ?? undefined, link: linkTo("/agent") }),
  [agentDraftJob.type]: (task, linkTo) => {
    const draft = resultOf(agentDraftJob, task);
    return {
      task: "Preparing a job agent draft",
      about: { candidate_id: inputOf(agentDraftJob, task)?.candidateId },
      result: draft ? { application_id: draft.applicationId } : undefined,
      link: linkTo("/agent"),
    };
  },
  [scorePostingJob.type]: async (task, linkTo) => {
    const posting = inputOf(scorePostingJob, task)?.posting;
    const fit = resultOf(scorePostingJob, task);
    const kept = posting
      ? await prisma.posting.findUnique({ where: { source_externalId: { source: posting.source, externalId: posting.externalId } }, select: { savedAt: true, dismissedAt: true } })
      : null;
    return {
      task: "Scoring a posting",
      about: { posting: posting ? [posting.title, posting.company].filter(Boolean).join(" at ") : undefined },
      result: fit ? { score: fit.score, band: fitBand(fit.score), reasons: fit.reasons, red_flags: fit.redFlags } : undefined,
      link: linkTo(kept?.savedAt ? viewHref("saved") : kept?.dismissedAt ? viewHref("dismissed") : "/jobs"),
    };
  },
  [refreshStartupsJob.type]: (task, linkTo) => {
    const refresh = resultOf(refreshStartupsJob, task);
    return {
      task: "Refreshing Startups",
      result: refresh
        ? {
            added: refresh.added,
            emails_found: refresh.emailsFound,
            sources: refresh.sources.map(({ source, found, error }) => ({ source: STARTUP_SOURCE_INFO[source].name, found, error: error ?? undefined })),
          }
        : undefined,
      link: linkTo("/startups"),
    };
  },
  [connectorDraftJob.type]: (task, linkTo) => {
    const draft = resultOf(connectorDraftJob, task);
    return { task: "Drafting an application", result: draft ? { application_id: draft.applicationId } : undefined, link: draft ? linkTo(`/applications/${draft.applicationId}`) : undefined };
  },
  [applyJob.type]: (task, linkTo) => {
    const input = inputOf(applyJob, task);
    const run = resultOf(applyJob, task);
    return {
      task: "Filling in the employer's application form",
      about: { application_id: input?.applicationId, run_id: input?.attemptId },
      result: run ? { outcome: run.status, note: withoutAddresses(run.note) } : undefined,
      link: input ? linkTo(`/applications/${input.applicationId}?tab=apply`) : undefined,
    };
  },
};

/** What to do next with a task as it stands. */
function nextFor(task: Task, told: Told): string | undefined {
  switch (task.status) {
    case JobStatus.QUEUED:
      return "It's waiting for other work to finish. Check again in a little while.";
    case JobStatus.RUNNING:
      return "Check again in a little while.";
    case JobStatus.FAILED:
      if (task.type === applyJob.type) return "Start a new apply run with start_apply.";
      if (task.type === draftReplyJob.type) return DRAFT_AGAIN;
      return "retry_task runs it again.";
    case JobStatus.DONE:
      return told.next;
  }
}

/** Registers these tools on the connector's server. */
export function registerTaskTools({ server, linkTo }: ToolContext): void {
  server.registerTool(
    "check_task",
    {
      title: "Check a task",
      description:
        "How background work is coming along, whichever tool or screen started it: its status, the step under way or why it failed, and once it's done what came of it, with a link.",
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ task_id }) => {
      const task = await prisma.job.findUnique({ where: { id: task_id }, select: TASK_FIELDS });
      if (!task) return failure(NO_TASK);
      const told = (await KINDS[task.type]?.(task, linkTo)) ?? { task: "Background work" };
      return text({
        task_id: task.id,
        task: told.task,
        ...told.about,
        status: STATUS[task.status],
        step: task.status === JobStatus.RUNNING ? (task.step ?? "Starting") : undefined,
        error: task.status === JobStatus.FAILED ? (task.error ?? JOB_MESSAGES.failed) : undefined,
        result: told.result,
        link: told.link,
        next: nextFor(task, told),
      });
    },
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel a task",
      description: "Stops background work that's queued or running, as Cancel on Dossier's screens does. It ends as cancelled, and check_task then says how to run it again.",
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ task_id }) => {
      const task = await prisma.job.findUnique({ where: { id: task_id }, select: { status: true } });
      if (!task) return failure(NO_TASK);
      if (isFinished(task)) return failure("That task has already finished, so there's nothing to cancel. check_task shows how it ended.");
      await cancelJob(task_id);
      const after = await prisma.job.findUnique({ where: { id: task_id }, select: { status: true } });
      // A running task stops at its next step.
      if (after && !isFinished(after)) return text({ task_id, status: "stopping", next: "It stops at its next step. check_task shows when it has." });
      return text({ task_id, status: "cancelled" });
    },
  );

  server.registerTool(
    "retry_task",
    {
      title: "Retry a task",
      description:
        "Runs failed or cancelled background work again, as Retry on Dossier's screens does: the same task with the same input, so nothing is duplicated. Follow it with check_task.",
      inputSchema: z.object({ task_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ task_id }) => {
      const task = await prisma.job.findUnique({ where: { id: task_id }, select: { type: true } });
      if (!task) return failure(NO_TASK);
      // An apply run may press Send when the user allowed it for runs she starts; one Claude starts never does.
      if (task.type === applyJob.type) return failure("An apply run can't be run again from here. Start a new apply run with start_apply.");
      // Run again, it would draft from an email dismissed or answered since, and save the draft back onto it.
      if (task.type === draftReplyJob.type) return failure(DRAFT_AGAIN);
      if (!(await retryJob(task_id))) return failure("This can't be retried: it's still running or already done.");
      return started(task_id);
    },
  );
}
