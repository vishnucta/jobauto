import "server-only";

import { z } from "zod";

import { loadProfile } from "@/lib/profile-data";
import { outreachFacts } from "@/lib/recruiters/facts";
import { recruiterFields } from "@/lib/recruiters/fields";
import { addStarterRecruiters, createRecruiter, getRecruiter, listRecruiters, removeRecruiter, setRecruiterStatus, snoozeRecruiter, updateRecruiter } from "@/lib/recruiters/store";
import {
  followUpDue,
  listOrder,
  matchesFilter,
  nextStep,
  outreachDraft,
  RECRUITER_STATUSES,
  sameAgency,
  SNOOZE_DAYS,
  SOURCE_LABEL,
  type OutreachKind,
  type RecruiterFilter,
  type RecruiterView,
} from "@/lib/recruiters/types";

import { failure, text, type ToolContext } from "../kit";

// Recruiters, under Find jobs (jobauto fork): what the Recruiters tab shows
// and what its buttons do. As on the screen, nothing here sends anything: a
// message is drafted from the profile, and the user sends it from their own
// mail. "Contacted" and "replied" are the user's word, so they are recorded
// only when the user says so. A recruiter's address and notes are read one
// recruiter at a time, as a startup's addresses are, and never in the list.

const GONE = "That recruiter is no longer in the list.";
const NOT_WAITING = "Only a recruiter you're waiting to hear from can be snoozed.";

/** The Recruiters tab's filters, as a tool names them. */
const FILTERS = { all: "ALL", to_contact: "TO_CONTACT", waiting: "WAITING", replied: "REPLIED", due: "DUE" } as const satisfies Record<string, RecruiterFilter>;

const id = z.string().min(1).max(64);

const day = (iso: string | null) => iso?.slice(0, 10) ?? undefined;

/** A recruiter as Claude sees it in a list: where the conversation stands, without the address or the notes. */
function recruiterLine(recruiter: RecruiterView, now: Date) {
  return {
    id: recruiter.id,
    name: recruiter.name,
    contact_name: recruiter.contactName || undefined,
    speciality: recruiter.speciality || undefined,
    website: recruiter.website || undefined,
    status: recruiter.status,
    next_step: nextStep(recruiter, now),
    follow_up_due: followUpDue(recruiter, now) || undefined,
    found: SOURCE_LABEL[recruiter.source],
    has_email: recruiter.email !== "",
    has_notes: recruiter.notes !== "",
  };
}

/** One recruiter whole: its address, notes and history too. */
function recruiterDetail(recruiter: RecruiterView, now: Date) {
  return {
    ...recruiterLine(recruiter, now),
    email: recruiter.email || undefined,
    notes: recruiter.notes || undefined,
    contacted: day(recruiter.contactedAt),
    follow_up: day(recruiter.followUpAt),
    history: recruiter.events.map((event) => ({ at: day(event.at), text: event.text })),
  };
}

export function registerRecruiterTools({ server, linkTo }: ToolContext): void {
  const link = linkTo("/recruiters");

  server.registerTool(
    "list_recruiters",
    {
      title: "List recruiters",
      description:
        "The agencies and recruiters on Find jobs → Recruiters, as the tab lists them: those with a follow-up due first, then those still to write to. " +
        "Agencies that came up in searches and jobs are added there on their own. Give id to read one with its address, notes and history. " +
        "To write to one, draft the message with draft_recruiter_message.",
      inputSchema: z.object({
        id: id.optional().describe("One recruiter, with its address, notes and history"),
        filter: z.enum(["all", "to_contact", "waiting", "replied", "due"]).optional().describe("all (the default), to_contact (not written to yet), waiting (written to, no answer), replied, or due (a follow-up is due)"),
        limit: z.number().int().min(1).max(100).optional().describe("The most to list; 30 by default"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id: recruiterId, filter, limit }) => {
      const now = new Date();
      if (recruiterId) {
        const recruiter = await getRecruiter(recruiterId);
        return recruiter ? text({ ...recruiterDetail(recruiter, now), link }) : failure(GONE);
      }
      const all = await listRecruiters();
      const shown = all.filter((recruiter) => matchesFilter(recruiter, FILTERS[filter ?? "all"], now)).toSorted((a, b) => listOrder(a, now) - listOrder(b, now));
      return text({
        counts: Object.fromEntries(Object.entries(FILTERS).map(([name, value]) => [name, all.filter((recruiter) => matchesFilter(recruiter, value, now)).length])),
        next: all.length === 0 ? "No recruiters yet. Call add_suggested_recruiters for the agencies suggested for finance in Hamburg, or add_recruiter for one the user knows." : undefined,
        recruiters: shown.slice(0, limit ?? 30).map((recruiter) => recruiterLine(recruiter, now)),
        link,
      });
    },
  );

  server.registerTool(
    "add_recruiter",
    {
      title: "Add a recruiter",
      description:
        "Adds an agency or recruiter the user knows to the list, as Add a recruiter does. Nothing is sent. " +
        "One already on the list under the same name isn't added twice: update it with update_recruiter.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200).describe("The agency or recruiter, e.g. 'Robert Walters'"),
        contact_name: z.string().max(200).optional().describe("The person to write to"),
        email: z.string().max(320).optional().describe("Their address, only if the user gave it"),
        website: z.string().max(2000).optional().describe("Starting with https://"),
        speciality: z.string().max(200).optional().describe("What they place people in, e.g. 'Finance and accounting'"),
        notes: z.string().max(5_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, contact_name, email, website, speciality, notes }) => {
      const parsed = recruiterFields.safeParse({ name, contactName: contact_name ?? "", email: email ?? "", website: website ?? "", speciality: speciality ?? "", notes: notes ?? "" });
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Those details can't be saved.");
      const have = (await listRecruiters()).find((recruiter) => sameAgency(recruiter.name, parsed.data.name));
      if (have) return failure(`${have.name} is already on the list (id ${have.id}). Change it with update_recruiter.`);
      const added = await createRecruiter(parsed.data);
      return text({ ...recruiterDetail(added, new Date()), message: "Added.", link });
    },
  );

  server.registerTool(
    "update_recruiter",
    {
      title: "Update a recruiter",
      description: "Changes the details of a recruiter on the list: only what's given is changed, and an empty string clears a detail. It doesn't change where the conversation stands: that is set_recruiter_status.",
      inputSchema: z.object({
        id,
        name: z.string().max(200).optional(),
        contact_name: z.string().max(200).optional(),
        email: z.string().max(320).optional(),
        website: z.string().max(2000).optional().describe("Starting with https://"),
        speciality: z.string().max(200).optional(),
        notes: z.string().max(5_000).optional().describe("Replaces the notes"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id: recruiterId, name, contact_name, email, website, speciality, notes }) => {
      if ([name, contact_name, email, website, speciality, notes].every((value) => value === undefined)) {
        return failure("Say what to change: name, contact_name, email, website, speciality or notes.");
      }
      const current = await getRecruiter(recruiterId);
      if (!current) return failure(GONE);
      const parsed = recruiterFields.safeParse({
        name: name ?? current.name,
        contactName: contact_name ?? current.contactName,
        email: email ?? current.email,
        website: website ?? current.website,
        speciality: speciality ?? current.speciality,
        notes: notes ?? current.notes,
      });
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Those details can't be saved.");
      const saved = await updateRecruiter(recruiterId, parsed.data);
      return saved ? text({ ...recruiterDetail(saved, new Date()), link }) : failure(GONE);
    },
  );

  server.registerTool(
    "set_recruiter_status",
    {
      title: "Record where a recruiter stands",
      description:
        "Records where the conversation with a recruiter stands, as 'I wrote to them', 'They replied' and 'Not interested' do: CONTACTED starts the follow-up clock (a week), REPLIED and NOT_INTERESTED stop it, NOT_CONTACTED puts it back on the list. " +
        "Dossier sends nothing, so only when the user says they wrote or heard back.",
      inputSchema: z.object({ id, status: z.enum(RECRUITER_STATUSES) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id: recruiterId, status }) => {
      const moved = await setRecruiterStatus(recruiterId, status);
      return moved ? text({ ...recruiterDetail(moved, new Date()), link }) : failure(GONE);
    },
  );

  server.registerTool(
    "snooze_recruiter",
    {
      title: "Snooze a follow-up",
      description: `Waits ${SNOOZE_DAYS} more days before the follow-up to a recruiter is due, as Snooze does. Only for one the user has written to and is waiting to hear from.`,
      inputSchema: z.object({ id }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id: recruiterId }) => {
      const current = await getRecruiter(recruiterId);
      if (!current) return failure(GONE);
      if (current.status !== "CONTACTED") return failure(NOT_WAITING);
      const snoozed = await snoozeRecruiter(recruiterId);
      return snoozed ? text({ ...recruiterDetail(snoozed, new Date()), link }) : failure(NOT_WAITING);
    },
  );

  server.registerTool(
    "remove_recruiter",
    {
      title: "Remove a recruiter",
      description: "Takes a recruiter off the list with its history, as Remove does, and remembers the name so a later search or job doesn't put it back. Only when the user said so.",
      inputSchema: z.object({ id }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id: recruiterId }) => {
      const current = await getRecruiter(recruiterId);
      if (!current || !(await removeRecruiter(recruiterId))) return failure(GONE);
      return text({ removed: current.name, message: "Removed. A search or job won't put it back; adding it again with add_recruiter will.", link });
    },
  );

  server.registerTool(
    "add_suggested_recruiters",
    {
      title: "Add the suggested agencies",
      description: "Adds the agencies suggested for finance in Hamburg that the list doesn't have yet, as Add suggested agencies does.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const added = await addStarterRecruiters();
      return text({ added, message: added === 0 ? "They're all on the list already." : `Added ${added} ${added === 1 ? "agency" : "agencies"}.`, link });
    },
  );

  server.registerTool(
    "draft_recruiter_message",
    {
      title: "Draft a message to a recruiter",
      description:
        "The message the Recruiters tab drafts for a recruiter: a first one, or a follow-up to the one the user marked as sent (the default once they have). " +
        "It states only what the profile says. Nothing is sent and the recruiter's address isn't in it: the user opens it on the tab, reads and edits it, and sends it from their own mail.",
      inputSchema: z.object({ id, kind: z.enum(["first", "follow-up"]).optional().describe("first, or follow-up") }),
      annotations: { readOnlyHint: true },
    },
    async ({ id: recruiterId, kind }) => {
      const [recruiter, profile] = await Promise.all([getRecruiter(recruiterId), loadProfile()]);
      if (!recruiter) return failure(GONE);
      const sort: OutreachKind = kind ?? (recruiter.status === "CONTACTED" && recruiter.contactedAt ? "follow-up" : "first");
      const draft = outreachDraft(recruiter, sort, outreachFacts(profile));
      return text({
        recruiter: recruiter.name,
        kind: sort,
        subject: draft.subject,
        body: draft.body,
        has_email: recruiter.email !== "",
        next: "Nothing has been sent. The user sends it from their own mail, then tells you, and you record it with set_recruiter_status.",
        link,
      });
    },
  );
}
