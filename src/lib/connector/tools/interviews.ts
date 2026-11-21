import "server-only";

import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { isAiUsable } from "@/lib/ai/config";
import { isoInZone } from "@/lib/dates";
import { followInCalendar, interviewMoment, saveInterviewDate } from "@/lib/interview-date";
import { addNextRound, prepSchema, saveRoundDetails, tickPrepItem, upcomingRound } from "@/lib/interviews";
import { keepMessageDraft, letMessageDraftGo, startMessageDraft } from "@/lib/jobs/write-message";
import { MESSAGE_KINDS, messageDraftSchema, MESSAGE_TITLES } from "@/lib/message-draft";
import { saveOfferDetails } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { failure, started, text, type ToolContext } from "../kit";
import { WRITTEN_IN_CLAUDE } from "../write";

// After applying (Dossier 1.15, jobauto fork): an application's interview
// rounds, its offer, and the follow-up or answer to the offer drafted for
// it, as the Interview and Offer columns on its page keep them, with the
// rounds' Getting ready ticks. Nothing is sent: a drafted message waits on
// the page, where the user sends it, and is let go here only on her word.
// get_application reads all three (rounds, offer, message draft).

const GONE = "That application no longer exists.";

const applicationId = z.string().min(1).max(100).describe("The application's id, from list_applications");

type Round = { id: string; round: number; at: Date | null; minutes: number | null; place: string; people: string; notes: string; prep: unknown };

/** An application's rounds as Claude reads them, first one first, dates in the user's time zone. */
export function roundsView(rounds: readonly Round[], timeZone: string) {
  const upcoming = upcomingRound(rounds);
  return rounds
    .toSorted((a, b) => a.round - b.round)
    .map((round) => {
      const prep = prepSchema.safeParse(round.prep);
      return {
        round_id: round.id,
        round: round.round,
        still_to_come: round === upcoming || undefined,
        at: round.at ? isoInZone(round.at, timeZone) : null,
        minutes: round.minutes ?? undefined,
        place: round.place || undefined,
        people: round.people.split("\n").filter((line) => line.trim()),
        notes: round.notes || undefined,
        // "Getting ready", with its ticks, numbered as tick_getting_ready takes them.
        getting_ready: prep.success ? prep.data.map((item, index) => ({ number: index + 1, item: item.text, done: item.done })) : undefined,
      };
    });
}

type Offer = { salary: string; decideBy: Date | null; startDate: Date | null; holidays: string; office: string };

/** A calendar day the Offer table keeps, "2026-12-01". */
const day = (date: Date) => date.toISOString().slice(0, 10);

/** The offer as Claude reads it; null without one. */
export const offerView = (offer: Offer | null) =>
  offer && {
    salary: offer.salary,
    start_date: offer.startDate ? day(offer.startDate) : null,
    holidays: offer.holidays,
    office: offer.office,
    decide_by: offer.decideBy ? day(offer.decideBy) : null,
  };

/** A drafted message as Claude reads it, without who it's to: an employer's address is contact details all the same. */
export function messageDraftView(value: unknown) {
  const draft = messageDraftSchema.safeParse(value);
  if (!draft.success) return undefined;
  return { kind: draft.data.kind, what: MESSAGE_TITLES[draft.data.kind], subject: draft.data.subject, body: draft.data.body, drafted: draft.data.at.slice(0, 10) };
}

const ROUND_FIELDS = { id: true, round: true, at: true, minutes: true, place: true, people: true, notes: true, prep: true } as const;

/** Registers these tools on the connector's server. */
export function registerInterviewTools({ server, linkTo }: ToolContext): void {
  const page = (id: string, tab?: "email") => linkTo(`/applications/${id}${tab ? `?tab=${tab}` : ""}`);

  server.registerTool(
    "update_interview_round",
    {
      title: "Add or change an interview round",
      description:
        "Sets an interview round's date, length, place, people and notes, as the Interview column on the application's page does. Only the fields given change. " +
        "A date goes to the round still to come, or starts the next round (in Google Calendar too when Dossier keeps interviews there). " +
        "Without round_id the details go to the round still to come, or a new round once every round is past.",
      inputSchema: z.object({
        id: applicationId,
        round_id: z.string().min(1).max(100).optional().describe("A round from get_application"),
        at: z.string().max(40).nullable().optional().describe("e.g. '2026-11-04T14:00' in the user's time zone, or with an offset; null removes the date"),
        minutes: z.number().int().min(1).max(24 * 60).nullable().optional().describe("How long it takes"),
        place: z.string().trim().max(300).optional().describe("An address, or e.g. 'Microsoft Teams'"),
        people: z.array(z.string().trim().min(1).max(200)).max(20).optional().describe("Who it's with, one each, e.g. 'Erika Mustermann, Head of Finance'"),
        notes: z.string().trim().max(10_000).optional().describe("How it went, or anything to remember"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, round_id, at: asked, minutes, place, people, notes }) => {
      const details = { minutes, place, people: people?.join("\n"), notes };
      const changingDetails = Object.values(details).some((value) => value !== undefined);
      if (asked === undefined && !changingDetails) return failure("Say what to change: at, minutes, place, people or notes.");
      const timeZone = await lastKnownTimeZone();
      const at = typeof asked === "string" ? interviewMoment(asked.trim(), timeZone) : null;
      if (typeof asked === "string" && !at) return failure("Give the date and time like 2026-11-04T14:00, or null to remove it.");
      const application = await prisma.application.findUnique({ where: { id }, select: { status: true } });
      if (!application) return failure(GONE);

      const rounds = await prisma.interview.findMany({ where: { applicationId: id }, select: ROUND_FIELDS, orderBy: { round: "asc" } });
      if (round_id && !rounds.some((round) => round.id === round_id)) return failure("That round isn't on this application. get_application lists its rounds.");
      const upcoming = upcomingRound(rounds);
      // As on the page, only the round to come has its date set; a past round keeps the date it had.
      if (asked !== undefined && round_id && round_id !== upcoming?.id) return failure("Only the round still to come takes a date. Leave out round_id to set it.");

      const done: string[] = [];
      let target = round_id ?? upcoming?.id;
      if (asked !== undefined) {
        await saveInterviewDate(id, at);
        done.push(await followInCalendar(id, at));
        // The round that took the date: the one to come, or the next one it started.
        const after = await prisma.interview.findMany({ where: { applicationId: id }, select: { id: true, round: true, at: true }, orderBy: { round: "asc" } });
        target = upcoming?.id ?? after.findLast((round) => at !== null && round.at?.getTime() === at.getTime())?.id ?? upcomingRound(after)?.id;
      }
      if (changingDetails) {
        if (!target) {
          // "Add the next round": every round is past, or there's none yet.
          const added = await addNextRound(id);
          target = added?.id;
          if (added) done.push(`Added round ${added.round}.`);
        }
        const round = target ? await prisma.interview.findUnique({ where: { id: target }, select: ROUND_FIELDS }) : null;
        if (!round) return failure("That round no longer exists. get_application lists the rounds there are now.");
        await saveRoundDetails(id, round.id, {
          minutes: minutes === undefined ? round.minutes : minutes,
          place: place ?? round.place,
          people: details.people ?? round.people,
          notes: notes ?? round.notes,
        });
        done.push(`Round ${round.round} saved.`);
      }

      const now = await prisma.interview.findMany({ where: { applicationId: id }, select: ROUND_FIELDS, orderBy: { round: "asc" } });
      return text({
        id,
        done,
        rounds: roundsView(now, timeZone),
        time_zone: timeZone,
        next:
          application.status !== ApplicationStatus.INTERVIEW
            ? "The rounds show on the application's page and the dashboard once it's in Interview: move it there with set_application_status."
            : undefined,
        link: page(id),
      });
    },
  );

  server.registerTool(
    "update_offer",
    {
      title: "Change the offer",
      description:
        "Saves an application's offer, as its Offer column does: the salary, start date, holidays, office and the day to decide by. " +
        "Only the fields given change ('' or null clears one). get_application reads the offer.",
      inputSchema: z.object({
        id: applicationId,
        salary: z.string().trim().max(200).optional().describe("As they wrote it, e.g. '€62,000 a year'"),
        start_date: z.iso.date().nullable().optional().describe("YYYY-MM-DD"),
        holidays: z.string().trim().max(200).optional().describe("e.g. '30 days'"),
        office: z.string().trim().max(300).optional().describe("Where, and how often, e.g. 'Hamburg, 3 days a week'"),
        decide_by: z.iso.date().nullable().optional().describe("YYYY-MM-DD; it shows on the board and the dashboard"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, salary, start_date, holidays, office, decide_by }) => {
      if ([salary, start_date, holidays, office, decide_by].every((value) => value === undefined)) {
        return failure("Say what to change: salary, start_date, holidays, office or decide_by.");
      }
      const application = await prisma.application.findUnique({ where: { id }, select: { status: true, offer: true } });
      if (!application) return failure(GONE);
      const before = offerView(application.offer);
      await saveOfferDetails(id, {
        salary: salary ?? before?.salary ?? "",
        startDate: start_date === undefined ? (before?.start_date ?? null) : start_date,
        holidays: holidays ?? before?.holidays ?? "",
        office: office ?? before?.office ?? "",
        decideBy: decide_by === undefined ? (before?.decide_by ?? null) : decide_by,
      });
      const after = await prisma.offer.findUnique({ where: { applicationId: id } });
      return text({
        id,
        offer: offerView(after),
        next: application.status !== ApplicationStatus.OFFER ? "It shows on the application's page once it's in Offer: move it there with set_application_status." : undefined,
        link: page(id),
      });
    },
  );

  server.registerTool(
    "tick_getting_ready",
    {
      title: "Tick a Getting ready item",
      description:
        "Ticks or unticks an item of an interview round's Getting ready list, as its checkbox on the application's page does, once the user says it's done (or not). " +
        "get_application lists the rounds with their getting_ready items, first item number 1.",
      inputSchema: z.object({
        id: applicationId,
        round_id: z.string().min(1).max(100).describe("The round, from get_application"),
        item: z.number().int().min(1).max(100).describe("The item's number in the round's getting_ready list, from 1"),
        done: z.boolean().default(true).describe("false unticks it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, round_id, item, done }) => {
      if (!(await prisma.application.count({ where: { id } }))) return failure(GONE);
      if (!(await tickPrepItem(id, round_id, item - 1, done))) return failure("There's no such item. get_application lists each round's getting_ready items, numbered from 1.");
      const [rounds, timeZone] = await Promise.all([prisma.interview.findMany({ where: { applicationId: id }, select: ROUND_FIELDS, orderBy: { round: "asc" } }), lastKnownTimeZone()]);
      const round = roundsView(rounds, timeZone).find((entry) => entry.round_id === round_id);
      return text({ id, round: round?.round, getting_ready: round?.getting_ready, link: page(id) });
    },
  );

  server.registerTool(
    "settle_message_draft",
    {
      title: "Let a drafted message go",
      description:
        "Lets the follow-up or answer to an offer drafted on the application's page go, as its buttons do: sent true is I sent it, for one the user sent from their own mail, " +
        "which starts Quiet for again from today; sent false is Discard, which deletes the draft for good. Nothing is sent either way. Use it only after the user said which.",
      inputSchema: z.object({
        id: applicationId,
        sent: z.boolean().describe("true: the user sent it themselves; false: discard it"),
      }),
      // Discard deletes the draft's text, which can't be undone.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, sent }) => {
      const application = await prisma.application.findUnique({ where: { id }, select: { messageDraft: true } });
      if (!application) return failure(GONE);
      const draft = messageDraftView(application.messageDraft);
      if (!draft) return failure("There's no drafted message on this application. draft_follow_up drafts one.");
      await letMessageDraftGo(id, { sent });
      return text({
        id,
        done: sent ? `Noted that the user sent “${draft.subject}”. Quiet for starts again from today.` : `Discarded “${draft.subject}”.`,
        link: page(id),
      });
    },
  );

  server.registerTool(
    "draft_follow_up",
    {
      title: "Draft a follow-up",
      description:
        "Drafts a follow-up to the employer, or with kind an answer to the offer (accept, more: ask for more, decline), and keeps it on the application's page, in place of any draft there, for the user to read, change and send. Nothing is sent. " +
        "Write it yourself from facts in the profile and give subject and body, or leave them out to have Dossier's AI draft it (follow it with check_task). get_application reads the draft.",
      inputSchema: z.object({
        id: applicationId,
        kind: z.enum(MESSAGE_KINDS).default("follow-up"),
        subject: z.string().trim().min(1).max(500).optional(),
        body: z.string().trim().min(1).max(20_000).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ id, kind, subject, body }) => {
      if ((subject === undefined) !== (body === undefined)) return failure("Give both subject and body, or neither to have Dossier's AI draft it.");
      const application = await prisma.application.findUnique({ where: { id }, select: { status: true, messageDraft: true } });
      if (!application) return failure(GONE);
      // As on the page, where the answers to an offer are on its Offer column.
      if (kind !== "follow-up" && application.status !== ApplicationStatus.OFFER) return failure("Answers to an offer are for an application in Offer. Move it there with set_application_status first.");
      // What it replaces, so nothing the user changed by hand is lost unseen.
      const replaced = messageDraftView(application.messageDraft);
      const answer = { id, kind, replaced: replaced ? { subject: replaced.subject, body: replaced.body } : undefined, link: page(id) };
      if (subject !== undefined && body !== undefined) {
        await keepMessageDraft(id, kind, { subject, body, writtenWith: WRITTEN_IN_CLAUDE });
        return text({ ...answer, drafted: true, next: "It waits on the application's page; the user sends it from there." });
      }
      if (!(await isAiUsable())) return failure("Dossier has no AI model of its own set up. Write it yourself and give subject and body.");
      return started(await startMessageDraft(id, kind), answer);
    },
  );
}
