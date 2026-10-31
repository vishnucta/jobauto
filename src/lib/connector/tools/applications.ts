import "server-only";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { eraseApplication, setApplicationArchived } from "@/lib/application-lifecycle";
import { addApplicationNote, deleteApplicationNote, noteBody, updateApplicationNote } from "@/lib/application-notes";
import { isoInZone } from "@/lib/dates";
import { lastEmailWriting, putBackEmail, writeApplicationEmail } from "@/lib/email-writing";
import { addFact, MAX_FACTS } from "@/lib/facts";
import { followInCalendar, interviewMoment, saveInterviewDate } from "@/lib/interview-date";
import { prisma } from "@/lib/prisma";
import { loadFacts } from "@/lib/profile-data";
import { startupAddress } from "@/lib/startups/types";
import { statusInfo } from "@/lib/status";
import { undoStatusChange } from "@/lib/status-changes";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { failure, started, text, type ToolContext } from "../kit";

// An application's notes, interview date, facts, startup, archiving,
// deleting, status undo and its email draft (jobauto fork): what its page,
// the Applications board and "Write to them" on Startups do with it, except
// its documents and the Apply tab. The tools call the library functions the
// page's actions call, whose ActionErrors are written for the user, so
// Claude gets them as they are.

const GONE = "That application no longer exists.";

const applicationId = z.string().min(1).max(100).describe("The application's id, from list_applications");
const factId = z.string().min(1).max(100);
/** As on the Job posting tab: about a short paragraph, a fact and not a document. */
const factText = z.string().trim().min(1, "Write the fact first.").max(1000);

/** Runs a tool's work; an ActionError it throws becomes the tool's failure. */
async function attempt(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ActionError) return failure(error.message);
    throw error;
  }
}

/** "2026-10-23" */
const day = (date: Date) => date.toISOString().slice(0, 10);

/** "1 fact", "2 facts" */
const factCount = (count: number) => `${count} ${count === 1 ? "fact" : "facts"}`;

/** The same fact, whatever its spacing or case. */
const sameFact = (fact: string) => fact.replace(/\s+/g, " ").trim().toLowerCase();

type FactChanges = { add: string[]; change: { fact_id: string; text: string }[]; remove: string[] };

/**
 * Checks changes to an application's facts (APP-15) before anything changes:
 * the facts are its own, none is both changed and removed, and they stay
 * within MAX_FACTS. Returns the facts to add, without ones it has already,
 * and the text of those it removes.
 */
async function checkFacts(applicationId: string, { add, change, remove }: FactChanges) {
  const current = await loadFacts(applicationId);
  const own = new Set(current.map((fact) => fact.id));
  const unknown = [...new Set([...remove, ...change.map((entry) => entry.fact_id)])].filter((id) => !own.has(id));
  if (unknown.length > 0) throw new ActionError(`${unknown.length === 1 ? "That fact isn't" : "Those facts aren't"} on this application: ${unknown.join(", ")}.`);
  const removing = new Set(remove);
  if (change.some((entry) => removing.has(entry.fact_id))) throw new ActionError("A fact can be changed or removed, not both.");

  // The facts as they'll be, so one it has already isn't added again.
  const kept = new Map(current.filter((fact) => !removing.has(fact.id)).map((fact) => [fact.id, fact.text]));
  for (const entry of change) kept.set(entry.fact_id, entry.text);
  const known = new Set([...kept.values()].map(sameFact));
  const adding: string[] = [];
  const there: string[] = [];
  for (const fact of add) {
    (known.has(sameFact(fact)) ? there : adding).push(fact);
    known.add(sameFact(fact));
  }
  if (kept.size + adding.length > MAX_FACTS) throw new ActionError(`An application keeps up to ${MAX_FACTS} facts. Remove one it no longer needs first.`);
  return { adding, there, removed: current.filter((fact) => removing.has(fact.id)).map((fact) => fact.text) };
}

/** Removes, changes and adds an application's facts, once checkFacts has passed them. */
async function saveFacts(applicationId: string, { change, remove }: FactChanges, adding: string[]): Promise<void> {
  const gone = "That fact no longer exists.";
  for (const id of new Set(remove)) {
    const { count } = await prisma.fact.deleteMany({ where: { id, applicationId } });
    if (count === 0) throw new ActionError(gone);
  }
  for (const entry of change) {
    const { count } = await prisma.fact.updateMany({ where: { id: entry.fact_id, applicationId }, data: { text: entry.text } });
    if (count === 0) throw new ActionError(gone);
  }
  for (const fact of adding) await addFact(applicationId, fact);
}

/**
 * Links an application to the startup it's written to (#222), as starting it
 * with "Write to them" on Startups does, or unlinks it with null; says what
 * it did. The email Dossier writes then gets the address the startup
 * publishes, and the startup counts as contacted once the application is
 * sent. A startup another application is linked to stays theirs, and nothing
 * changes until that's checked.
 */
async function linkStartup(applicationId: string, startupId: string | null): Promise<string> {
  const linked = await prisma.startup.findUnique({ where: { applicationId }, select: { id: true, company: true } });
  if (startupId === null) {
    if (!linked) return "It wasn't linked to a startup.";
    await prisma.startup.updateMany({ where: { id: linked.id, applicationId }, data: { applicationId: null } });
    return `Unlinked from ${linked.company}.`;
  }
  if (linked?.id === startupId) return `It was linked to ${linked.company} already.`;

  const startup = await prisma.startup.findUnique({ where: { id: startupId }, select: { company: true, emails: true, applicationId: true } });
  if (!startup) throw new ActionError("That startup is no longer in the list.");
  const taken = `Another application is linked to ${startup.company} already.`;
  if (startup.applicationId) throw new ActionError(taken);
  await prisma.$transaction(async (tx) => {
    // An application is written to one startup: the one it was linked to lets go.
    if (linked) await tx.startup.updateMany({ where: { id: linked.id, applicationId }, data: { applicationId: null } });
    const { count } = await tx.startup.updateMany({ where: { id: startupId, applicationId: null }, data: { applicationId } });
    if (count === 0) throw new ActionError(taken);
  });
  return [
    `Linked to ${startup.company}${linked ? ` instead of ${linked.company}` : ""}.`,
    startupAddress(startup.emails) ? "When Dossier writes the email, it fills in the address the startup publishes." : "",
    "The startup counts as contacted once the application is sent.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Registers these tools on the connector's server. */
export function registerApplicationTools({ server, linkTo }: ToolContext): void {
  const page = (id: string, tab?: "notes" | "email" | "posting") => linkTo(`/applications/${id}${tab ? `?tab=${tab}` : ""}`);

  server.registerTool(
    "list_notes",
    {
      title: "Read an application's notes",
      description:
        "An application's private notes, newest first, with the note_id save_note takes, and its status changes, as its Notes tab shows them. Read them only when the user asks.",
      inputSchema: z.object({ id: applicationId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const application = await prisma.application.findUnique({
        where: { id },
        select: {
          createdAt: true,
          notes: { orderBy: { createdAt: "desc" }, select: { id: true, body: true, createdAt: true } },
          events: { orderBy: [{ at: "desc" }, { id: "desc" }], select: { from: true, to: true, at: true } },
        },
      });
      if (!application) return failure(GONE);
      return text({
        id,
        notes: application.notes.map((note) => ({ note_id: note.id, text: note.body, written: day(note.createdAt) })),
        status_changes: application.events.map((event) => ({ from: statusInfo(event.from).label, to: statusInfo(event.to).label, on: day(event.at) })),
        created: day(application.createdAt),
        link: page(id, "notes"),
      });
    },
  );

  server.registerTool(
    "save_note",
    {
      title: "Add, change or delete a note",
      description:
        "Adds a private note to an application, or changes or deletes one by its note_id from list_notes. A deleted note can't be brought back, but the answer keeps its text.",
      inputSchema: z.object({
        id: applicationId,
        note_id: z.string().min(1).max(100).optional().describe("The note to change or delete; leave out to add one"),
        body: noteBody.optional().describe("The note's text"),
        delete: z.boolean().optional().describe("Delete the note instead"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id, note_id, body, delete: remove }) =>
      attempt(async () => {
        if (remove) {
          if (!note_id) return failure("Say which note to delete with its note_id from list_notes.");
          const note = await deleteApplicationNote(id, note_id);
          return text({ note_id, deleted: true, text: note.body, written: day(note.createdAt), link: page(id, "notes") });
        }
        if (body === undefined) return failure("Write the note's text in body.");
        if (note_id) {
          await updateApplicationNote(id, note_id, body);
          return text({ note_id, changed: true, link: page(id, "notes") });
        }
        const note = await addApplicationNote(id, body);
        return text({ note_id: note.id, added: true, link: page(id, "notes") });
      }),
  );

  server.registerTool(
    "update_application",
    {
      title: "Update an application",
      description:
        "Archives an application or brings it back, sets or removes its next interview (in Google Calendar too when Dossier keeps interviews there), " +
        "changes the facts Dossier's AI is told for it, or links it to the startup it's written to. Give only what changes. When facts change, the answer lists them all with their fact_id.",
      inputSchema: z.object({
        id: applicationId,
        archived: z.boolean().optional().describe("true takes it off the board, where it still counts on the dashboard; false brings it back"),
        interview_at: z
          .string()
          .max(40)
          .nullable()
          .optional()
          .describe("The next interview, e.g. '2026-11-04T14:00' in the user's time zone, or with an offset; null removes it"),
        add_facts: z.array(factText).max(MAX_FACTS).optional().describe("What Dossier's AI should know for this application only, e.g. 'A friend on their team referred me.'"),
        change_facts: z.array(z.object({ fact_id: factId, text: factText })).max(MAX_FACTS).optional(),
        remove_facts: z.array(factId).max(MAX_FACTS).optional().describe("By fact_id"),
        startup_id: z
          .string()
          .min(1)
          .max(100)
          .nullable()
          .optional()
          .describe("The startup from list_startups it's written to, linked as Write to them on Startups does; null unlinks it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, archived, interview_at, add_facts = [], change_facts = [], remove_facts = [], startup_id }) =>
      attempt(async () => {
        const facts: FactChanges = { add: add_facts, change: change_facts, remove: remove_facts };
        const changingFacts = add_facts.length + change_facts.length + remove_facts.length > 0;
        if (archived === undefined && interview_at === undefined && !changingFacts && startup_id === undefined) {
          return failure("Say what to change: archived, interview_at, add_facts, change_facts, remove_facts or startup_id.");
        }
        const timeZone = await lastKnownTimeZone();
        const at = typeof interview_at === "string" ? interviewMoment(interview_at.trim(), timeZone) : null;
        if (typeof interview_at === "string" && !at) return failure("Give the interview's date and time like 2026-11-04T14:00, or null to remove it.");
        const before = await prisma.application.findUnique({ where: { id }, select: { archivedAt: true } });
        if (!before) return failure(GONE);

        // What can be refused is checked before anything changes: the facts, then the startup as it's linked.
        const factPlan = changingFacts ? await checkFacts(id, facts) : null;
        const linked = startup_id === undefined ? null : await linkStartup(id, startup_id);

        const done: string[] = [];
        if (factPlan) {
          await saveFacts(id, facts, factPlan.adding);
          if (remove_facts.length > 0) done.push(`Removed ${factCount(new Set(remove_facts).size)}.`);
          if (change_facts.length > 0) done.push(`Changed ${factCount(new Set(change_facts.map((entry) => entry.fact_id)).size)}.`);
          if (factPlan.adding.length > 0) done.push(`Added ${factCount(factPlan.adding.length)}.`);
          if (factPlan.there.length > 0) done.push(`${factCount(factPlan.there.length)} ${factPlan.there.length === 1 ? "was" : "were"} there already.`);
        }
        if (interview_at !== undefined) {
          await saveInterviewDate(id, at);
          done.push(await followInCalendar(id, at));
        }
        if (archived !== undefined) {
          if ((before.archivedAt !== null) === archived) done.push(archived ? "It was archived already." : "It wasn't archived.");
          else {
            await setApplicationArchived(id, archived);
            done.push(archived ? "Archived. It's off your board, and still counts on your dashboard." : "Back on your board.");
          }
        }
        if (linked) done.push(linked);

        const after = await prisma.application.findUnique({ where: { id }, select: { status: true, archivedAt: true, nextInterviewAt: true } });
        if (!after) return failure(GONE);
        const onlyFacts = archived === undefined && interview_at === undefined && startup_id === undefined;
        return text({
          id,
          done,
          archived: after.archivedAt !== null,
          next_interview: after.nextInterviewAt ? isoInZone(after.nextInterviewAt, timeZone) : null,
          time_zone: after.nextInterviewAt ? timeZone : undefined,
          // Facts for this application, as its Job posting tab lists them.
          facts: factPlan ? (await loadFacts(id)).map((fact) => ({ fact_id: fact.id, text: fact.text })) : undefined,
          removed_facts: factPlan && factPlan.removed.length > 0 ? factPlan.removed : undefined,
          next:
            at && after.status !== ApplicationStatus.INTERVIEW
              ? "It shows on the dashboard once the application is in Interview: move it there with set_application_status."
              : undefined,
          link: page(id, onlyFacts ? "posting" : undefined),
        });
      }),
  );

  server.registerTool(
    "delete_application",
    {
      title: "Delete an application",
      description:
        "Deletes an application with its tailored documents, chat, notes, facts, history, Gmail mail and apply runs. " +
        "It can't be undone: call it only when the user asked to delete this application. To keep one out of the way, archive it with update_application instead.",
      inputSchema: z.object({ id: applicationId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      attempt(async () => {
        const application = await prisma.application.findUnique({ where: { id }, select: { title: true, company: true } });
        if (!application) return failure(GONE);
        await eraseApplication(id);
        return text({ id, deleted: true, title: application.title, company: application.company, link: linkTo("/applications") });
      }),
  );

  server.registerTool(
    "undo_status_change",
    {
      title: "Undo a status change",
      description:
        "Undoes an application's latest status change, as Undo after moving it does: back to the status before, with the sent date it had. " +
        "The change is taken out of its history, so use it right after a change the user wants taken back.",
      inputSchema: z.object({ id: applicationId }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      // The newest change, as undoStatusChange finds it.
      const latest = await prisma.statusEvent.findFirst({
        where: { applicationId: id },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        select: { id: true, to: true, at: true },
      });
      if (!latest) return failure((await prisma.application.count({ where: { id } })) > 0 ? "There's no status change to undo." : GONE);
      const result = await undoStatusChange(prisma, latest.id);
      if (result.outcome === "not-found") return failure(GONE);
      if (result.outcome === "superseded") return failure("The status has changed again since, so this change can't be undone.");
      return text({ id, status: statusInfo(result.status).label, was: statusInfo(latest.to).label, changed_on: day(latest.at), link: page(id) });
    },
  );

  server.registerTool(
    "write_application_email",
    {
      title: "Have Dossier write the email",
      description:
        "Has Dossier's own AI model write the email that goes with an application, or write it again, on its Email tab; nothing is sent. " +
        "It needs an AI provider in Dossier's settings; follow it with check_task. With undo, puts back the email the last rewrite replaced instead.",
      inputSchema: z.object({
        id: applicationId,
        undo: z.boolean().optional().describe("Put back the email the last rewrite replaced, instead of writing"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, undo }) =>
      attempt(async () => {
        if (!undo) return started(await writeApplicationEmail(id), { application_id: id, link: page(id, "email") });
        if (!(await prisma.application.count({ where: { id } }))) return failure(GONE);
        const jobId = await lastEmailWriting(id);
        if (!jobId) return failure("There's nothing to undo.");
        await putBackEmail(id, jobId);
        return text({ id, done: "Put the email back.", link: page(id, "email") });
      }),
  );
}
