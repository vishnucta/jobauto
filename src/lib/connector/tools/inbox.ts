import "server-only";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApplicationStatus, EmailDirection, type ReplyKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { approveCandidate } from "@/lib/agent/draft";
import { isAiUsable } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { googleConnection, type GoogleConnection } from "@/lib/google/account";
import { workingHours } from "@/lib/google/availability";
import { GoogleError } from "@/lib/google/errors";
import { loadConversation, loadEmail, loadInbox, type EmailView } from "@/lib/google/inbox-data";
import {
  confirmInterviewTime,
  dismissReply,
  linkThread,
  readReplyAgain,
  saveReplyText,
  setReplyHandled,
  slotsToOffer,
  startReplyDraft,
  takeSuggestedStatus,
} from "@/lib/google/replies";
import { EMAIL_CHANGED, previewApplicationEmail, replySubject, sendApplicationEmail, sendReply } from "@/lib/google/send";
import { googleSettingsSchema, saveGoogleSettingChanges } from "@/lib/google/settings";
import { formatSlot } from "@/lib/google/slots";
import { checkInboxNow } from "@/lib/google/sync";
import { logServerError } from "@/lib/log";
import { messages } from "@/lib/messages";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";

import { failure, started, text, type ToolContext } from "../kit";

// The inbox (E15, jobauto fork): employers' replies from Gmail, their answers,
// interview times from Google Calendar, sending the application with Gmail,
// and the settings for all of it. Only the two send tools send anything, and
// only once the user has said to. The user's own address stays out of answers.

const NOT_CONNECTED = "Google isn't connected to Dossier. Connect it in the app under Settings → Google.";
const NO_SENDING = "Dossier isn't allowed to send with Gmail yet. Allow it in the app under Settings → Google.";

/** Answers being sent right now, by email id. On globalThis so the dev server's hot reloads keep it. */
const replying: Set<string> = ((globalThis as { connectorReplying?: Set<string> }).connectorReplying ??= new Set());

/** How long the same answer in the same thread counts as a repeat of one already sent. */
const REPEAT_WINDOW_MS = 15 * 60_000;
const NO_READING = "Dossier isn't allowed to read Gmail yet. Allow it in the app under Settings → Google.";
const NO_CALENDAR = "Dossier isn't allowed to use Google Calendar yet. Allow it in the app under Settings → Google.";
const GONE = "That email is no longer in Dossier.";
const REOPENED = "It was marked as needing no answer. Now it needs one again.";
const PLACEHOLDER = /\[…\]|\[\.\.\.\]/;

const KINDS: Record<ReplyKind, string> = {
  REJECTION: "rejection",
  INTERVIEW: "interview invite",
  QUESTION: "question",
  OFFER: "offer",
  ACKNOWLEDGEMENT: "acknowledgement",
  OTHER: "other",
};

const id = z.string().min(1).max(100);

type Connected = Extract<GoogleConnection, { status: "connected" }>;

/**
 * Runs a tool's work once Google is connected. The app's and Google's own
 * failures come back as the message the screens show; anything else is
 * logged and kept vague, as the Server Actions do.
 */
async function withGoogle(work: (connection: Connected) => Promise<CallToolResult>): Promise<CallToolResult> {
  const connection = await googleConnection();
  if (connection.status !== "connected") return failure(NOT_CONNECTED);
  try {
    return await work(connection);
  } catch (error) {
    if (error instanceof GoogleError || error instanceof ActionError || error instanceof AiError) return failure(error.message);
    logServerError("Claude connector, inbox", error);
    return failure(messages.unexpected);
  }
}

/** An employer's email the user can act on, or what's wrong. */
async function incoming(emailId: string): Promise<EmailView | { error: string }> {
  const email = await loadEmail(emailId);
  if (!email) return { error: GONE };
  if (email.direction === EmailDirection.OUTGOING) return { error: "That's an email the user sent. Use the employer's email instead." };
  return email;
}

const DATE_TIME: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/** "Sat, 17 Oct 2026, 15:00" in the user's time zone. */
const at = (date: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { ...DATE_TIME, timeZone }).format(date);

const who = (email: EmailView) => (email.direction === EmailDirection.OUTGOING ? "the user" : email.fromName || email.fromAddress);

const applicationOf = (email: EmailView) =>
  email.application
    ? { id: email.application.id, company: email.application.company, role: email.application.role, status: statusInfo(email.application.status).label }
    : null;

/** An email in a list: who, when, and what it's about in a line. */
function emailLine(email: EmailView, timeZone: string) {
  return {
    id: email.id,
    from: who(email),
    date: at(email.sentAt, timeZone),
    subject: email.subject || undefined,
    summary: email.summary || email.body.replace(/\s+/g, " ").trim().slice(0, 140) || undefined,
    kind: email.kind ? KINDS[email.kind] : undefined,
    application: applicationOf(email) ?? undefined,
    suggested_status: email.suggestedStatus ? statusInfo(email.suggestedStatus).label : undefined,
    answer_drafted: email.replyDraft ? true : undefined,
    read_by_ai: email.read || email.direction === EmailDirection.OUTGOING ? undefined : false,
  };
}

/** What the AI read in a reply; null until it has. */
function reading(email: EmailView, timeZone: string) {
  if (!email.read) return null;
  return {
    kind: email.kind ? KINDS[email.kind] : undefined,
    summary: email.summary,
    questions: email.questions,
    suggested_status: email.suggestedStatus ? statusInfo(email.suggestedStatus).label : undefined,
    agreed_interview: email.confirmedAt ? { start: email.confirmedAt.toISOString(), when: at(email.confirmedAt, timeZone) } : undefined,
  };
}

/**
 * Why the user can't see an email's drafted answer in the app, if they
 * can't: the Conversation tab has an answer box only for a linked reply
 * Dossier's AI has read, while it needs an answer.
 */
function answerHidden(email: EmailView): string | undefined {
  if (!email.application) {
    return "The app shows answers only for mail linked to an application, so the user can't see this one there. Show it to them here, or link the email with update_email.";
  }
  if (!email.read) return "The app shows the answer once Dossier's AI has read the email (update_email with change read_again). Until then, show it to the user here.";
  return undefined;
}

/** Registers these tools on the connector's server. */
export function registerInboxTools({ server, linkTo }: ToolContext): void {
  const linkFor = (email: EmailView) => linkTo(email.application ? `/applications/${email.application.id}?tab=conversation` : "/inbox");

  server.registerTool(
    "check_inbox",
    {
      title: "Check the inbox",
      description:
        "Fetches new mail from Gmail now, as Check now in the Inbox does: replies are linked to their applications and read by Dossier's AI. Returns how many new emails are about applications; see them with list_emails.",
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    () =>
      withGoogle(async (connection) => {
        if (!connection.canRead) return failure(NO_READING);
        if (!(await loadSettings()).gmailRead) return failure("Reading replies is off. Turn it on with update_google_settings (gmail_read: true) or in the app under Settings → Google.");
        const result = await checkInboxNow();
        if (!result) return text({ status: "already checking", next: "It'll be done in a moment. Then call list_emails.", link: linkTo("/inbox") });
        return text({ new_emails: result.kept, read_by_ai: result.read, link: linkTo("/inbox"), next: result.kept > 0 ? "See them with list_emails." : undefined });
      }),
  );

  server.registerTool(
    "list_emails",
    {
      title: "List emails",
      description:
        "The inbox: employers' replies that need an answer, mail not linked to an application yet, and recent updates that need nothing, with ids and one-line summaries. " +
        "With application_id, that application's whole conversation instead, oldest first.",
      inputSchema: z.object({ application_id: id.optional().describe("Only this application's emails, the user's own included") }),
      annotations: { readOnlyHint: true },
    },
    ({ application_id }) =>
      withGoogle(async () => {
        const { timeZone } = await workingHours();
        if (application_id) {
          const application = await prisma.application.findUnique({ where: { id: application_id }, select: { id: true, company: true, role: true, title: true, status: true } });
          if (!application) return failure("That application no longer exists.");
          const emails = await loadConversation(application.id);
          return text({
            application: { id: application.id, company: application.company, role: application.role || application.title, status: statusInfo(application.status).label },
            time_zone: timeZone,
            emails: emails.map((email) => emailLine(email, timeZone)),
            link: linkTo(`/applications/${application.id}?tab=conversation`),
          });
        }
        const inbox = await loadInbox();
        return text({
          time_zone: timeZone,
          needs_an_answer: inbox.waiting.map((email) => emailLine(email, timeZone)),
          needs_a_look: inbox.unmatched.map((email) => emailLine(email, timeZone)),
          needs_a_look_hint: inbox.unmatched.length > 0 ? "Dossier couldn't tell which application these are about. Link each with update_email, or dismiss it." : undefined,
          updates: inbox.updates.map((email) => emailLine(email, timeZone)),
          link: linkTo("/inbox"),
        });
      }),
  );

  server.registerTool(
    "read_email",
    {
      title: "Read an email",
      description: "One email with its text, what Dossier's AI read in it (kind, summary, questions, suggested status, agreed interview time) and its drafted answer.",
      inputSchema: z.object({ email_id: id }),
      annotations: { readOnlyHint: true },
    },
    ({ email_id }) =>
      withGoogle(async () => {
        const email = await loadEmail(email_id);
        if (!email) return failure(GONE);
        const { timeZone } = await workingHours();
        const outgoing = email.direction === EmailDirection.OUTGOING;
        const read = reading(email, timeZone);
        const next = outgoing
          ? []
          : [
              !email.application && "Link it to its application with update_email.",
              !read && "Dossier's AI hasn't read it yet: update_email with change read_again.",
              read?.suggested_status && `It suggests moving the application to ${read.suggested_status}: update_email with change accept_status or decline_status.`,
              read?.agreed_interview && "It agrees an interview time: add it with confirm_interview.",
              !email.handled && (email.replyDraft ? "Show the user the drafted answer before anything is sent." : "Draft an answer with draft_email_reply, or write one and save it with save_email_reply."),
            ].filter(Boolean);
        return text({
          id: email.id,
          from: outgoing ? "the user" : { name: email.fromName || undefined, address: email.fromAddress },
          date: at(email.sentAt, timeZone),
          subject: email.subject,
          text: email.body,
          application: applicationOf(email),
          ai_read: outgoing ? undefined : read,
          answer: outgoing
            ? undefined
            : { handled: email.handled, draft: email.replyDraft || undefined, profile_doesnt_say: email.replyGaps.length > 0 ? email.replyGaps : undefined },
          next: next.length > 0 ? next : undefined,
          link: linkFor(email),
        });
      }),
  );

  server.registerTool(
    "draft_email_reply",
    {
      title: "Have Dossier draft an answer",
      description:
        "Has Dossier's own AI draft the answer to an employer's email from the profile and the application, offering free times when they ask to meet. " +
        "Only when an AI provider is set up in Dossier; otherwise write it yourself and save it with save_email_reply. Follow it with check_task, then read_email shows the draft.",
      inputSchema: z.object({
        email_id: id,
        note: z.string().max(2000).optional().describe("What the answer should say or stress, in the user's words, e.g. 'My notice period is 3 months'"),
        slots: z
          .array(z.iso.datetime({ offset: true }))
          .max(8)
          .optional()
          .describe("For an interview invite: the start times to offer, from find_free_slots. Left out, the first free ones are offered"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    ({ email_id, note, slots }) =>
      withGoogle(async () => {
        const email = await incoming(email_id);
        if ("error" in email) return failure(email.error);
        if (!(await isAiUsable())) return failure("Dossier has no AI model of its own set up. Write the answer yourself and save it with save_email_reply.");
        const taskId = await startReplyDraft({ emailId: email.id, note: note ?? "", slots: slots ?? null });
        // As with Answer anyway: mail marked as needing no answer needs one again, so the Conversation tab shows the draft.
        const reopened = email.handled && (await setReplyHandled(email.id, false));
        return started(taskId, {
          email_id: email.id,
          reopened: reopened ? REOPENED : undefined,
          not_in_app: answerHidden(email),
          then: "Once it's done, read_email with this email_id shows the drafted answer.",
          link: linkFor(email),
        });
      }),
  );

  server.registerTool(
    "save_email_reply",
    {
      title: "Save an answer",
      description:
        "Saves the answer to an employer's email as its draft in Dossier, e.g. one you wrote or the user changed, and marks the email as needing an answer. Nothing is sent. " +
        "The user sees the draft on the application's Conversation tab once the email is linked and Dossier's AI has read it.",
      inputSchema: z.object({ email_id: id, text: z.string().max(20_000).describe("The whole answer as it would be sent; empty removes the draft") }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    ({ email_id, text: answer }) =>
      withGoogle(async () => {
        const email = await incoming(email_id);
        if ("error" in email) return failure(email.error);
        await saveReplyText(email.id, answer);
        const written = answer.trim() !== "";
        // As with Answer anyway: mail marked as needing no answer needs one again, so the Conversation tab shows the draft.
        const reopened = written && email.handled && (await setReplyHandled(email.id, false));
        return text({
          email_id: email.id,
          saved: true,
          to: who(email),
          reopened: reopened ? REOPENED : undefined,
          not_in_app: written ? answerHidden(email) : undefined,
          next: !written
            ? undefined
            : PLACEHOLDER.test(answer)
              ? "Fill in the parts marked […] before it can be sent."
              : "Show the user the answer. Send it with send_email_reply only after they said to send it.",
          link: linkFor(email),
        });
      }),
  );

  server.registerTool(
    "send_email_reply",
    {
      title: "Send an answer",
      description:
        "Sends an answer to an employer's email from the user's Gmail, in the same thread, and marks the email as answered. It can't be unsent: call it only after the user said to send this exact text.",
      inputSchema: z.object({ email_id: id, text: z.string().min(1).max(20_000).describe("The answer, exactly as the user agreed to send it") }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ email_id, text: answer }) =>
      withGoogle(async (connection) => {
        if (!connection.canSend) return failure(NO_SENDING);
        const email = await incoming(email_id);
        if ("error" in email) return failure(email.error);
        // A call repeated after a lost answer, or made twice at once, must not send the answer twice.
        if (replying.has(email.id)) return failure("That answer is being sent right now. Check read_email in a moment instead of sending it again.");
        const repeat = await prisma.emailMessage.findFirst({
          where: { threadId: email.threadId, direction: EmailDirection.OUTGOING, body: answer, sentAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS) } },
          select: { id: true },
        });
        if (repeat) return failure("That exact answer went out a few minutes ago, so it isn't sent again. Check read_email.");
        replying.add(email.id);
        try {
          await sendReply(email.id, answer);
        } finally {
          replying.delete(email.id);
        }
        return text({ email_id: email.id, sent: true, to: who(email), subject: replySubject(email.subject), link: linkFor(email) });
      }),
  );

  server.registerTool(
    "update_email",
    {
      title: "Update an email",
      description:
        "Changes an email in the inbox: marks it as needing no answer or needing one again, links it to an application or unlinks it, dismisses it as not job-related, " +
        "has Dossier's AI read it again, or takes up or turns down the status it suggests.",
      inputSchema: z.object({
        email_id: id,
        change: z
          .enum(["handled", "not_handled", "link", "unlink", "dismiss", "read_again", "accept_status", "decline_status"])
          .describe(
            "handled: needs no answer. not_handled: needs one again. link: it's about application_id, and so is the rest of its thread. " +
              "dismiss: not job-related, for mail not linked to an application; its text is deleted for good and it isn't fetched again. read_again: Dossier's AI reads it again. " +
              "accept_status, decline_status: move the application to the status it suggests, or don't.",
          ),
        application_id: id.optional().describe("For link: the application it's about"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ email_id, change, application_id }) =>
      withGoogle(async () => {
        const email = await incoming(email_id);
        if ("error" in email) return failure(email.error);
        switch (change) {
          case "handled":
          case "not_handled": {
            if (!(await setReplyHandled(email.id, change === "handled"))) return failure(GONE);
            return text({ email_id: email.id, handled: change === "handled", link: linkFor(email) });
          }
          case "link":
          case "unlink": {
            if (change === "link" && !application_id) return failure("Say which application it's about: give application_id.");
            await linkThread(email.id, change === "link" ? application_id! : null);
            const linked = await loadEmail(email.id);
            return text({
              email_id: email.id,
              application: linked ? applicationOf(linked) : null,
              note: change === "link" ? "Replies in this thread will go there too." : undefined,
              link: linked ? linkFor(linked) : linkTo("/inbox"),
            });
          }
          case "dismiss": {
            // Only mail that isn't linked, as in the app: dismissing deletes its text for good.
            if (email.application) return failure("That email is linked to an application. Mark it handled instead, or unlink it first if it isn't job-related.");
            if (!(await dismissReply(email.id))) return failure(GONE);
            return text({ email_id: email.id, dismissed: true, link: linkTo("/inbox") });
          }
          case "read_again": {
            await readReplyAgain(email.id);
            // The AI marks acknowledgements and rejections as needing no answer; one with an answer drafted still needs it.
            if (email.replyDraft.trim() && !email.handled) await setReplyHandled(email.id, false);
            const read = await loadEmail(email.id);
            if (!read) return failure(GONE);
            return text({ email_id: email.id, ai_read: reading(read, (await workingHours()).timeZone), handled: read.handled, link: linkFor(read) });
          }
          case "accept_status":
          case "decline_status": {
            if (!email.suggestedStatus) return failure("That email doesn't suggest a status.");
            if (change === "accept_status" && !email.application) return failure("Link this email to an application first.");
            const taken = await takeSuggestedStatus(email.id, change === "accept_status");
            if (!taken) return text({ email_id: email.id, suggestion: "turned down", link: linkFor(email) });
            return text({ email_id: email.id, application_id: email.application?.id, status: statusInfo(taken.status).label, changed: taken.eventId !== null, link: linkFor(email) });
          }
        }
      }),
  );

  server.registerTool(
    "find_free_slots",
    {
      title: "Find free interview times",
      description:
        "Free interview times over the next two weeks, from Google Calendar and the working hours in Settings → Google. Pass the starts to draft_email_reply as slots to offer, or an agreed one to confirm_interview.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      withGoogle(async (connection) => {
        if (!connection.canUseCalendar) return failure(NO_CALENDAR);
        const offer = await slotsToOffer();
        if (!offer.fromCalendar) {
          return failure("Offering times from the calendar is off. Turn it on with update_google_settings (calendar_availability: true) or in the app under Settings → Google.");
        }
        return text({
          time_zone: offer.timeZone,
          slots: offer.slots,
          note: offer.slots.length === 0 ? "No free times in the working hours over the next two weeks." : undefined,
          link: linkTo("/settings?section=google"),
        });
      }),
  );

  server.registerTool(
    "confirm_interview",
    {
      title: "Add an agreed interview",
      description:
        "Adds an interview agreed in an employer's email to its application and the dashboard and, when that's on in Settings → Google, to Google Calendar. Moves the application to Interview unless move_to_interview is false.",
      inputSchema: z.object({
        email_id: id.describe("The employer's email the time was agreed in; it has to be linked to an application"),
        start: z.iso.datetime({ offset: true }).optional().describe("When it starts, e.g. 2026-11-04T14:00:00+01:00. Left out, the time the email agreed on"),
        move_to_interview: z.boolean().optional().describe("Also move the application to Interview; true unless given"),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ email_id, start, move_to_interview }) =>
      withGoogle(async () => {
        const email = await incoming(email_id);
        if ("error" in email) return failure(email.error);
        if (!email.application) return failure("Link this email to an application first.");
        const when = start ? new Date(start) : email.confirmedAt;
        if (!when) return failure("Give the interview's start: that email doesn't agree on a time.");
        const moveToInterview = move_to_interview ?? true;
        const done = await confirmInterviewTime({ emailId: email.id, start: when, moveToInterview });
        const hours = await workingHours();
        return text({
          application_id: done.applicationId,
          interview: formatSlot({ start: when, end: new Date(when.getTime() + hours.slotMinutes * 60_000) }, hours.timeZone),
          start: when.toISOString(),
          in_calendar: done.eventLink !== null,
          calendar_link: done.eventLink ?? undefined,
          status: moveToInterview ? "Interview" : undefined,
          link: linkTo(`/applications/${done.applicationId}`),
        });
      }),
  );

  server.registerTool(
    "send_application_email",
    {
      title: "Send an application with Gmail",
      description:
        "Sends an application's email from the user's Gmail with its tailored resume and cover letter as PDFs, as Send with Gmail on the Email tab does; a Draft moves to Sent. " +
        "Without confirm it only shows what would go out, with a confirm_token: show the user who it's to, the subject, the message and the attachments. " +
        "Call again with confirm true and that confirm_token only after they said to send it.",
      inputSchema: z.object({
        application_id: id,
        confirm: z.boolean().optional().describe("true sends it; left out, nothing is sent and you get what would go out"),
        confirm_token: z.string().max(100).optional().describe("With confirm: the confirm_token of what the user agreed to send"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ application_id, confirm, confirm_token }) =>
      withGoogle(async (connection) => {
        if (!connection.canSend) return failure(NO_SENDING);
        if (confirm && !confirm_token) {
          return failure("First show the user what would go out: call send_application_email without confirm. Then call it with confirm true and its confirm_token once they said to send it.");
        }
        const pending = await prisma.agentCandidate.findFirst({ where: { applicationId: application_id, application: { awaitingReview: true } }, select: { id: true } });
        const preview = await previewApplicationEmail(application_id);
        if (!confirm) {
          return text({
            application_id,
            sent: false,
            from: "The user's Gmail account",
            to: preview.to,
            subject: preview.subject,
            message: preview.body,
            attachments: preview.attachments,
            sent_before: preview.sentBefore || undefined,
            moves_to: preview.status === ApplicationStatus.DRAFT ? "Sent" : undefined,
            waiting_for_review: pending ? "The job agent drafted it and the user hasn't reviewed it yet. Sending it approves it." : undefined,
            confirm_token: preview.token,
            next: "Show the user all of this. Call again with confirm true and this confirm_token only after they said to send it.",
            link: linkTo(`/applications/${application_id}?tab=email`),
          });
        }
        // Only what the user saw goes out, and only once: an email changed since, or sent already, has another token.
        if (confirm_token !== preview.token) return failure(EMAIL_CHANGED);
        // A job agent draft waiting for review is approved first, as set_application_status does, once its email is complete.
        if (pending) await approveCandidate(pending.id);
        // Checked again as it goes out, in case it changed in the meantime.
        const sent = await sendApplicationEmail(application_id, { expected: confirm_token });
        return text({
          application_id,
          sent: true,
          attachments: sent.attachments,
          status: sent.eventId ? "Sent" : undefined,
          next: "Replies in its thread show up in the inbox.",
          link: linkTo(`/applications/${application_id}?tab=conversation`),
        });
      }),
  );

  const setting = googleSettingsSchema.shape;
  server.registerTool(
    "update_google_settings",
    {
      title: "Change the Google settings",
      description:
        "Changes how Dossier uses Gmail and Google Calendar: reading replies, which mail and how often, offering free times, adding interviews, the calendar and the working hours. " +
        "Returns the settings and what Google allows; call it without changes to see them.",
      inputSchema: z.object({
        gmail_read: setting.gmailRead.describe("Check Gmail for employers' replies"),
        gmail_scope: setting.gmailScope.describe("known: only threads the user started and company domains. all: every new email"),
        gmail_interval: setting.gmailInterval.describe("Minutes between inbox checks"),
        calendar_availability: setting.calendarAvailability.describe("Offer free times from the calendar when an employer asks to meet"),
        calendar_events: setting.calendarEvents.describe("Add agreed interviews to the calendar"),
        calendar_id: setting.calendarId.describe("The calendar to use: primary is the user's main one"),
        work_days: setting.workDays.describe("Working days, 1 = Monday to 7 = Sunday"),
        work_start: setting.workStart.describe("When the working day starts, HH:MM"),
        work_end: setting.workEnd.describe("When it ends, HH:MM"),
        work_time_zone: setting.workTimeZone.describe("For free times and interviews, e.g. Europe/Berlin; empty uses the browser's"),
        slot_minutes: setting.slotMinutes.describe("How long an interview is, in minutes"),
        buffer_minutes: setting.bufferMinutes.describe("Minutes kept free around other meetings"),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    (input) =>
      withGoogle(async (connection) => {
        const before = await loadSettings();
        await saveGoogleSettingChanges({
          gmailRead: input.gmail_read,
          gmailScope: input.gmail_scope,
          gmailInterval: input.gmail_interval,
          calendarAvailability: input.calendar_availability,
          calendarEvents: input.calendar_events,
          calendarId: input.calendar_id,
          workDays: input.work_days,
          // Both, so a day that would end before it starts is refused even when only one changes.
          ...(input.work_start || input.work_end ? { workStart: input.work_start ?? before.workStart, workEnd: input.work_end ?? before.workEnd } : {}),
          workTimeZone: input.work_time_zone,
          slotMinutes: input.slot_minutes,
          bufferMinutes: input.buffer_minutes,
        });
        const [settings, hours] = await Promise.all([loadSettings(), workingHours()]);
        return text({
          gmail_read: settings.gmailRead,
          gmail_scope: settings.gmailScope,
          gmail_interval: settings.gmailInterval,
          calendar_availability: settings.calendarAvailability,
          calendar_events: settings.calendarEvents,
          calendar_id: settings.calendarId,
          work_days: settings.workDays,
          work_start: settings.workStart,
          work_end: settings.workEnd,
          work_time_zone: settings.workTimeZone ?? "",
          time_zone_used: hours.timeZone,
          slot_minutes: settings.slotMinutes,
          buffer_minutes: settings.bufferMinutes,
          google_allows: { sending: connection.canSend, reading: connection.canRead, calendar: connection.canUseCalendar },
          last_inbox_check: connection.lastSyncAt?.toISOString(),
          inbox_problem: connection.syncProblem ?? undefined,
          link: linkTo("/settings?section=google"),
        });
      }),
  );
}
