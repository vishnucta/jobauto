import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { writeMessage } from "@/lib/ai/tasks";
import { extractedOf, unitsSchema } from "@/lib/application-data";
import { emailParts } from "@/lib/application-email";
import { formatCalendarDate, formatDay } from "@/lib/dates";
import { profileOfApplication } from "@/lib/frozen-copy";
import { MESSAGE_KINDS, messageDraftSchema, type MessageDraft, type MessageKind } from "@/lib/message-draft";
import { prisma } from "@/lib/prisma";
import { loadFactTexts } from "@/lib/profile-data";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";

/** The key of drafting an application's message, to find it again after a reload. */
export const messageJobKey = (applicationId: string) => `message:${applicationId}`;

/**
 * Drafts a follow-up or an answer to the offer (E30-7, E30-8) and keeps it
 * on the application, over any draft before it. Only ever on a click, and
 * never sent without the user.
 */
export const writeMessageJob = defineJob({
  type: "write-message",
  input: z.object({ applicationId: z.string().min(1), kind: z.enum(MESSAGE_KINDS) }),
  result: messageDraftSchema,
  async run({ applicationId, kind }, { step, signal }) {
    await step(kind === "follow-up" ? "Drafting a follow-up" : "Drafting your answer");
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { offer: true } });
    const [provider, options, profile, facts, timeZone] = await Promise.all([
      getAiProvider(),
      loadTaskOptions(),
      profileOfApplication(application.frozen, application.profileId),
      loadFactTexts(applicationId),
      lastKnownTimeZone(),
    ]);
    const { offer } = application;
    const { data, promptVersion } = await writeMessage(
      provider,
      {
        kind,
        name: profile.basics.name,
        profile,
        extracted: extractedOf(application),
        sent: application.sentAt ? formatDay(application.sentAt, timeZone) : null,
        offer: kind === "follow-up" ? null : { salary: offer?.salary ?? "", startDate: offer?.startDate ? formatCalendarDate(offer.startDate) : null, postedSalary: application.salary },
        facts,
      },
      { ...options, language: application.language || options.language, signal },
    );
    return keepMessageDraft(applicationId, kind, { subject: data.subject, body: data.body, writtenWith: promptVersion });
  },
});

/**
 * Keeps a drafted message on the application, over any draft before it,
 * addressed to whoever the application's email went to, when there is one.
 * The job keeps what the AI drafted; the Claude connector keeps what Claude
 * wrote (jobauto fork).
 */
export async function keepMessageDraft(applicationId: string, kind: MessageKind, { subject, body, writtenWith }: Pick<MessageDraft, "subject" | "body" | "writtenWith">): Promise<MessageDraft> {
  const email = await prisma.document.findFirst({ where: { applicationId, kind: DocumentKind.EMAIL }, select: { units: true } });
  const units = unitsSchema.safeParse(email?.units);
  const draft = { kind, to: units.success ? emailParts(units.data).to : "", subject, body, writtenWith, at: new Date().toISOString() };
  await prisma.application.update({ where: { id: applicationId }, data: { messageDraft: draft } });
  return draft;
}

/**
 * Lets a drafted message go: "I sent it" (sent some other way, so "Quiet
 * for" starts again from now, decided 17 November) or Discard. False when
 * the application is gone.
 */
export async function letMessageDraftGo(applicationId: string, { sent }: { sent: boolean }): Promise<boolean> {
  const { count } = await prisma.application.updateMany({ where: { id: applicationId }, data: { messageDraft: Prisma.DbNull, ...(sent ? { contactedAt: new Date() } : {}) } });
  return count > 0;
}

/** Drafts one in the background, as the page's buttons do; refused while one is being drafted already. Returns the job's id. */
export async function startMessageDraft(applicationId: string, kind: MessageKind): Promise<string> {
  const key = messageJobKey(applicationId);
  const [running] = await findUnfinishedJobs(key);
  if (running) throw new ActionError("A message is being drafted already. Try again once it's done.");
  return startJob(writeMessageJob, { applicationId, kind }, { key, applicationId });
}
