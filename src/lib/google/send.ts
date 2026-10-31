import "server-only";

import { createHash } from "node:crypto";

import { ApplicationStatus, DocumentKind, EmailDirection } from "@/generated/prisma/enums";
import { unitsSchema } from "@/lib/application-data";
import { emailAddresses, emailParts } from "@/lib/application-email";
import { resolveFileName } from "@/lib/file-name";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/prisma";
import { loadProfileName } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { applyStatusChange } from "@/lib/status-changes";

import { loadGoogleAccount } from "./account";
import { GoogleError } from "./errors";
import { sendMail } from "./gmail";
import type { Attachment } from "./mime";

// Sending through Gmail (E15-2): the application's email with its PDFs, and
// answers to employers in their thread. Each send is asked for by the user;
// nothing goes out on its own.

const PRINTED = [
  { kind: DocumentKind.RESUME, path: "resume" },
  { kind: DocumentKind.COVER_LETTER, path: "letter" },
] as const;

/** "Jane Doe <jane@gmail.com>", from the profile's name and the account. */
async function sender(address: string): Promise<string> {
  const name = (await loadProfileName()).trim().replace(/[<>"]/g, "");
  return name ? `${name} <${address}>` : address;
}

export type SentApplication = { threadId: string; eventId: string | null; attachments: string[] };

/** For Claude (#221): the email it showed the user isn't the one that would go out now. */
export const EMAIL_CHANGED = "The email changed or already went out. Show the user the preview again.";

// The applications whose email is going out right now. On globalThis, so
// the dev server's hot reloads keep them.
const globalForSend = globalThis as unknown as { sendingApplications?: Set<string> };
const sending: Set<string> = (globalForSend.sendingApplications ??= new Set());

/**
 * The application's email, checked, with the PDFs that go with it: their
 * file names and the pages they're printed from.
 */
async function applicationEmail(applicationId: string) {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, include: { documents: { select: { kind: true, units: true } } } });
  if (!application) throw new GoogleError("unavailable", "That application no longer exists.");

  const units = unitsSchema.safeParse(application.documents.find((document) => document.kind === DocumentKind.EMAIL)?.units);
  if (!units.success) throw new GoogleError("unavailable", "Write the email first.");
  const { to, subject, body } = emailParts(units.data);
  if (emailAddresses(to).length === 0) throw new GoogleError("unavailable", "Add who it's to first: the posting doesn't give an address.");
  if (!subject.trim() || !body.trim()) throw new GoogleError("unavailable", "The email needs a subject and a message.");

  const [name, settings] = await Promise.all([loadProfileName(), loadSettings()]);
  const printed = PRINTED.filter(({ kind }) => application.documents.some((document) => document.kind === kind)).map(({ kind, path }) => ({
    fileName: resolveFileName(settings.fileNamePattern, { name, company: application.company, role: application.role, doc: kind, date: new Date() }),
    page: `/print/${path}/${applicationId}`,
  }));
  return { application, name, to, subject, body, printed };
}

type ApplicationEmail = Awaited<ReturnType<typeof applicationEmail>>;

/**
 * A fingerprint of the email as it would go out, and of the sends before
 * it, for Claude to send only what it showed (#221): it stops matching once
 * the email changes or goes out.
 */
async function fingerprint({ application, to, subject, body, printed }: ApplicationEmail): Promise<string> {
  const sends = await prisma.emailMessage.count({ where: { applicationId: application.id, direction: EmailDirection.OUTGOING } });
  const parts = [to, subject, body, printed.map((file) => file.fileName), application.emailThreadId, sends];
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 16);
}

export type ApplicationEmailPreview = {
  to: string;
  subject: string;
  body: string;
  attachments: string[];
  status: ApplicationStatus;
  sentBefore: boolean;
  /** For sendApplicationEmail's `expected`: sends exactly this email, once. */
  token: string;
};

/** What sendApplicationEmail would send, for Claude to show before it goes (#221). */
export async function previewApplicationEmail(applicationId: string): Promise<ApplicationEmailPreview> {
  const email = await applicationEmail(applicationId);
  const { application, to, subject, body, printed } = email;
  return {
    to,
    subject,
    body,
    attachments: printed.map((file) => file.fileName),
    status: application.status,
    sentBefore: application.emailThreadId !== null,
    token: await fingerprint(email),
  };
}

/**
 * Sends the application's email from the connected account, with the
 * tailored resume and cover letter attached, keeps the thread to watch for
 * replies, and moves a draft to Sent. With `expected`, a preview's token,
 * it sends only the email that preview showed, and only once. One send per
 * application at a time, so a retry while the first is still going out
 * doesn't send it twice.
 */
export async function sendApplicationEmail(applicationId: string, { expected }: { expected?: string } = {}): Promise<SentApplication> {
  const account = await loadGoogleAccount();
  if (!account) throw new GoogleError("not-connected", "Connect your Google account in Settings → Google first.");
  if (sending.has(applicationId)) throw new GoogleError("unavailable", "It's being sent right now.");
  sending.add(applicationId);
  try {
    const email = await applicationEmail(applicationId);
    if (expected !== undefined && (await fingerprint(email)) !== expected) throw new GoogleError("unavailable", EMAIL_CHANGED);
    const { application, name, to, subject, body, printed } = email;
    const attachments: Attachment[] = [];
    for (const { fileName, page } of printed) attachments.push({ fileName, contentType: "application/pdf", data: await renderPdf(page) });

    const from = await sender(account.email);
    const sent = await sendMail({ from, to, subject, body, attachments });
    await prisma.$transaction([
      prisma.application.update({ where: { id: applicationId }, data: { emailThreadId: sent.threadId } }),
      prisma.emailMessage.upsert({
        where: { gmailId: sent.id },
        create: {
          gmailId: sent.id,
          threadId: sent.threadId,
          applicationId,
          direction: EmailDirection.OUTGOING,
          fromName: name.trim(),
          fromAddress: account.email.toLowerCase(),
          toAddress: to,
          subject,
          body,
          sentAt: new Date(),
          handledAt: new Date(),
        },
        update: {},
      }),
    ]);

    let eventId: string | null = null;
    if (application.status === ApplicationStatus.DRAFT) {
      const change = await applyStatusChange(prisma, applicationId, ApplicationStatus.SENT);
      if (change.outcome === "changed") eventId = change.event.id;
    }
    return { threadId: sent.threadId, eventId, attachments: attachments.map((file) => file.fileName) };
  } finally {
    sending.delete(applicationId);
  }
}

/** "Re: …", unless it already is. */
export const replySubject = (subject: string) => (/^\s*(re|aw|sv|antw)\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`);

/** Sends the answer to an employer's mail in its thread, and marks the mail as answered. */
export async function sendReply(emailId: string, body: string): Promise<{ applicationId: string | null }> {
  const account = await loadGoogleAccount();
  if (!account) throw new GoogleError("not-connected", "Connect your Google account in Settings → Google first.");
  const email = await prisma.emailMessage.findUnique({ where: { id: emailId } });
  if (!email) throw new GoogleError("unavailable", "That email is no longer in Dossier.");
  if (!body.trim()) throw new GoogleError("unavailable", "Write the answer first.");
  if (/\[…\]|\[\.\.\.\]/.test(body)) throw new GoogleError("unavailable", "Fill in the parts marked […] first.");

  const to = email.fromName ? `${email.fromName.replace(/[<>"]/g, "")} <${email.fromAddress}>` : email.fromAddress;
  const subject = replySubject(email.subject);
  const sent = await sendMail(
    { from: await sender(account.email), to, subject, body, inReplyTo: email.messageId || undefined },
    { threadId: email.threadId },
  );
  await prisma.$transaction([
    prisma.emailMessage.update({ where: { id: emailId }, data: { handledAt: new Date(), replyDraft: "", replyGaps: [] } }),
    prisma.emailMessage.upsert({
      where: { gmailId: sent.id },
      create: {
        gmailId: sent.id,
        threadId: sent.threadId,
        applicationId: email.applicationId,
        direction: EmailDirection.OUTGOING,
        fromName: (await loadProfileName()).trim(),
        fromAddress: account.email.toLowerCase(),
        toAddress: to,
        subject,
        body,
        sentAt: new Date(),
        handledAt: new Date(),
      },
      update: {},
    }),
  ]);
  return { applicationId: email.applicationId };
}
