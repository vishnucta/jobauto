import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ApplicationStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { isAiConfigured } from "@/lib/ai/config";
import { draftReplyJob, replyJobKey } from "@/lib/jobs/draft-reply";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { applyStatusChange } from "@/lib/status-changes";

import { googleConnection } from "./account";
import { proposeSlots, scheduleInterview, type CalendarSync } from "./availability";
import { formatSlot } from "./slots";
import { readReply } from "./sync";

// What's done with mail in the inbox (E15-3, E15-4, E15-5), from its screens
// and from Claude (#221): the answer drafted and saved, the mail marked as
// handled, linked, dismissed or read again, its suggested status taken up,
// and an agreed interview added.

const GONE = "That email is no longer in Dossier.";
const NEEDS_AI = "That needs an AI provider. Choose one in Settings → AI provider.";

/** Drafts (or redrafts) the answer to an email in the background; returns the job's id, or the one already drafting it. */
export async function startReplyDraft({ emailId, note, slots }: { emailId: string; note: string; slots: string[] | null }): Promise<string> {
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId }, select: { applicationId: true } });
  if (!email) throw new ActionError(GONE);
  if (!(await isAiConfigured())) throw new ActionError(NEEDS_AI);
  const [running] = await findUnfinishedJobs(replyJobKey(emailId));
  // Linked to its application, so deleting that deletes the job too.
  return running?.id ?? startJob(draftReplyJob, { emailId, note, slots }, { key: replyJobKey(emailId), applicationId: email.applicationId ?? undefined });
}

/** Saves the answer as written or edited by hand. */
export async function saveReplyText(emailId: string, body: string): Promise<void> {
  const { count } = await prisma.emailMessage.updateMany({ where: { id: emailId }, data: { replyDraft: body } });
  if (count === 0) throw new ActionError(GONE);
}

/** "No answer needed", or back to needing one. Returns whether the email is there. */
export async function setReplyHandled(emailId: string, handled: boolean): Promise<boolean> {
  const { count } = await prisma.emailMessage.updateMany({ where: { id: emailId }, data: { handledAt: handled ? new Date() : null } });
  return count > 0;
}

/** Links a mail to an application ("Needs a look"), with the rest of its thread. Null unlinks. */
export async function linkThread(emailId: string, applicationId: string | null): Promise<void> {
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId }, select: { threadId: true } });
  if (!email) throw new ActionError(GONE);
  if (applicationId && !(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError("That application no longer exists.");
  // Mail dismissed before has nothing left to show, so it stays dismissed.
  await prisma.emailMessage.updateMany({ where: { threadId: email.threadId, dismissedAt: null }, data: { applicationId } });
}

/**
 * "Not job-related": hidden from the inbox, and not fetched again. Only the
 * Gmail ids and the date stay, for the inbox check to skip it: the text,
 * who it's from and to, and what the AI read go. Returns whether the email
 * is there.
 */
export async function dismissReply(emailId: string): Promise<boolean> {
  const { count } = await prisma.emailMessage.updateMany({
    where: { id: emailId },
    data: {
      dismissedAt: new Date(),
      applicationId: null,
      fromName: "",
      fromAddress: "",
      toAddress: "",
      subject: "",
      messageId: "",
      body: "",
      kind: null,
      summary: "",
      questions: Prisma.DbNull,
      suggestedStatus: null,
      confirmedAt: null,
      classifiedWith: null,
      replyDraft: "",
      replyGaps: Prisma.DbNull,
      draftedWith: null,
    },
  });
  return count > 0;
}

/** "Read again": the AI reads a mail it couldn't before. */
export async function readReplyAgain(emailId: string): Promise<void> {
  if (!(await isAiConfigured())) throw new ActionError(NEEDS_AI);
  await readReply(emailId);
}

/**
 * Takes up a reply's suggested status, or turns it down; either way the
 * suggestion goes. Returns the status and the change's event (null when the
 * application was there already), or null when nothing was taken up.
 */
export async function takeSuggestedStatus(emailId: string, accept: boolean): Promise<{ status: ApplicationStatus; eventId: string | null } | null> {
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId }, select: { applicationId: true, suggestedStatus: true } });
  if (!email) throw new ActionError(GONE);
  await prisma.emailMessage.update({ where: { id: emailId }, data: { suggestedStatus: null } });
  if (!accept || !email.applicationId || !email.suggestedStatus) return null;
  const result = await applyStatusChange(prisma, email.applicationId, email.suggestedStatus);
  return { status: email.suggestedStatus, eventId: result.outcome === "changed" ? result.event.id : null };
}

export type OfferedSlot = { start: string; label: string };

/** Free times to offer, for the reply's slot picker: none while the calendar isn't allowed or in use. */
export async function slotsToOffer(): Promise<{ slots: OfferedSlot[]; timeZone: string | null; fromCalendar: boolean }> {
  const connection = await googleConnection();
  if (connection.status !== "connected" || !connection.canUseCalendar) return { slots: [], timeZone: null, fromCalendar: false };
  const { slots, timeZone, fromCalendar } = await proposeSlots();
  return { slots: slots.map((slot) => ({ start: slot.start.toISOString(), label: formatSlot(slot, timeZone) })), timeZone, fromCalendar };
}

/**
 * An agreed time: the application's next interview on the dashboard and,
 * when in use, in the calendar; with `moveToInterview`, the status too
 * (its event is null when it was there already). The email's agreed time
 * and suggestion are taken care of.
 */
export async function confirmInterviewTime({
  emailId,
  start,
  moveToInterview,
}: {
  emailId: string;
  start: Date;
  moveToInterview: boolean;
}): Promise<CalendarSync & { applicationId: string; eventId: string | null }> {
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId }, select: { applicationId: true } });
  if (!email?.applicationId) throw new ActionError("Link this email to an application first.");
  const sync = await scheduleInterview(email.applicationId, start);
  let eventId: string | null = null;
  if (moveToInterview) {
    const result = await applyStatusChange(prisma, email.applicationId, ApplicationStatus.INTERVIEW);
    if (result.outcome === "changed") eventId = result.event.id;
  }
  await prisma.emailMessage.update({ where: { id: emailId }, data: { confirmedAt: null, suggestedStatus: null } });
  return { ...sync, applicationId: email.applicationId, eventId };
}
