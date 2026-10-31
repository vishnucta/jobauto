import "server-only";

import { ChatRole, DocumentKind, VersionCause } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { isAiConfigured } from "@/lib/ai/config";
import { editsSchema, unitsSchema } from "@/lib/application-data";
import { WRITTEN_EMAIL_UNITS } from "@/lib/application-email";
import { PART_GONE } from "@/lib/document-edits";
import { updateDocuments } from "@/lib/document-units";
import { refineJob, refineJobKey } from "@/lib/jobs/refine";
import { regenerateUnitJob, unitJobKey } from "@/lib/jobs/regenerate-unit";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { isFrameUnit, withFrame, WRITTEN_FRAME_UNITS } from "@/lib/letter-frame";
import { prisma } from "@/lib/prisma";
import { isPublicationUnit, unitName } from "@/lib/unit-text";

// The AI's changes to a tailored document, and their Undo: one unit written
// again (E8-4) and the Refine with AI chat (E8-5, E8-6). The work runs in
// the background (src/lib/jobs); these start it. The application's page
// (src/app/(app)/applications/[id]/actions.ts) and the Claude connector
// (src/lib/connector/tools/documents.ts) both use them. A refusal is an
// ActionError, written for the user.

const GONE = "That application no longer exists.";

/**
 * "Regenerate" (E8-4): rewrites one unit in the background and returns the
 * job's id. Asking again while it's being rewritten follows the same job.
 */
export async function startUnitRewrite({
  applicationId,
  document,
  unitId,
  shown,
}: {
  applicationId: string;
  document: DocumentKind;
  unitId: string;
  /** For a letter part an older letter only shows (E8-11): the text on screen, stored before it's rewritten. */
  shown?: string;
}): Promise<string> {
  const frame = document === DocumentKind.COVER_LETTER && isFrameUnit(unitId);
  // The sender, date and signature come from the profile and the day, not the AI (E8-11).
  if ((frame && !WRITTEN_FRAME_UNITS.has(unitId)) || (document === DocumentKind.EMAIL && !WRITTEN_EMAIL_UNITS.has(unitId))) {
    throw new ActionError("This part isn't written by the AI. Edit it instead.");
  }
  // A publication is the user's own citation (#218).
  if (document === DocumentKind.RESUME && isPublicationUnit(unitId)) {
    throw new ActionError("A publication stays as you wrote it. Edit it instead.");
  }
  if (frame && shown) {
    await updateDocuments(applicationId, async (documents) => {
      const units = documents[document];
      if (units && !units.some((entry) => entry.id === unitId)) documents[document] = withFrame(units, { [unitId]: shown });
    });
  }
  const row = await prisma.document.findUnique({ where: { applicationId_kind: { applicationId, kind: document } } });
  const unit = row && unitsSchema.parse(row.units).find((entry) => entry.id === unitId);
  if (!unit) throw new ActionError(PART_GONE);

  for (const job of await findUnfinishedJobs(unitJobKey(applicationId))) {
    const input = regenerateUnitJob.input.safeParse(job.input);
    if (input.success && input.data.document === document && input.data.unitId === unitId) return job.id;
  }
  return startJob(regenerateUnitJob, { applicationId, document, unitId, from: unit.text }, { key: unitJobKey(applicationId), applicationId });
}

/**
 * Undo on the "Rewrote the summary." toast (E8-4): puts the previous
 * version back, unless the unit has changed again since.
 */
export async function restoreUnitText({
  applicationId,
  document,
  unitId,
  text,
  unverified,
  expected,
}: {
  applicationId: string;
  document: DocumentKind;
  unitId: string;
  text: string;
  unverified?: string[];
  /** The text it has now, which Undo replaces. */
  expected: string;
}): Promise<void> {
  await updateDocuments(applicationId, async (documents) => {
    const unit = documents[document]?.find((entry) => entry.id === unitId);
    if (!unit) throw new ActionError(PART_GONE);
    if (unit.text !== expected) throw new ActionError("It's been changed again since, so this can't be undone.");
    unit.text = text;
    if (unverified?.length) unit.unverified = unverified;
    else delete unit.unverified;
  }, { version: { cause: VersionCause.UNDONE } });
}

/** The answer on the Job posting tab, where there's nothing to change. */
const POSTING_REPLY = "I can change the resume, the cover letter or the email. Switch to one of them, or hover a section and pick “Ask AI”.";

/**
 * Sends a message from the Refine with AI panel (E8-5): saves it and starts
 * the reply in the background, returning the job's id. On the Job posting
 * tab without a picked unit, the reply comes at once and needs no AI.
 */
export async function sendChatMessage({
  applicationId,
  text,
  viewing,
  target,
}: {
  applicationId: string;
  text: string;
  /** The document on screen; null on the Job posting and Notes tabs, and on the Email tab before there's an email. */
  viewing: DocumentKind | null;
  /** The unit picked with "Ask AI". */
  target: { document: DocumentKind; unitId: string } | null;
}): Promise<{ jobId: string | null }> {
  if (!(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError(GONE);

  if (!viewing && !target) {
    const now = Date.now();
    await prisma.chatMessage.createMany({
      data: [
        { applicationId, role: ChatRole.USER, text, createdAt: new Date(now) },
        { applicationId, role: ChatRole.AI, text: POSTING_REPLY, createdAt: new Date(now + 1) },
      ],
    });
    return { jobId: null };
  }

  if (!(await isAiConfigured())) throw new ActionError("That needs an AI provider. Choose one in Settings → AI provider.");
  if ((await findUnfinishedJobs(refineJobKey(applicationId))).length > 0) {
    throw new ActionError("I'm still working on your last message. Send this one when I'm done.");
  }
  let targetLabel: string | null = null;
  if (target) {
    const row = await prisma.document.findUnique({ where: { applicationId_kind: { applicationId, kind: target.document } } });
    const unit = row && unitsSchema.parse(row.units).find((entry) => entry.id === target.unitId);
    if (!unit) throw new ActionError(PART_GONE);
    targetLabel = unit.label;
  }

  const message = await prisma.chatMessage.create({
    data: { applicationId, role: ChatRole.USER, text, targetUnit: targetLabel },
    select: { id: true },
  });
  const jobId = await startJob(refineJob, { applicationId, messageId: message.id, request: text, target, viewing }, { key: refineJobKey(applicationId), applicationId });
  return { jobId };
}

/** "A, B and C" */
const listOf = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * "Undo" under a reply in the chat (E8-6, APP-8): puts back what the reply
 * changed, units and tone, all or nothing, and returns the units it put
 * back. A unit edited again since is never overwritten; the refusal says
 * which.
 */
export async function undoChatMessage(applicationId: string, messageId: string): Promise<{ document: DocumentKind; unitId: string }[]> {
  const message = await prisma.chatMessage.findFirst({ where: { id: messageId, applicationId, role: ChatRole.AI } });
  const edits = message && editsSchema.safeParse(message.edits);
  if (!message || !edits?.success || edits.data.length === 0) throw new ActionError("There's nothing to undo in that message.");
  if (message.undone) throw new ActionError("That's already undone.");

  await updateDocuments(applicationId, async (documents, tx) => {
    const changed = edits.data.flatMap((edit) => {
      const unit = documents[edit.document]?.find((entry) => entry.id === edit.unitId);
      return unit?.text === edit.text ? [] : [`the ${unitName(unit ?? { id: edit.unitId, label: "" })}`];
    });
    if (changed.length > 0) {
      throw new ActionError(
        `You've changed ${listOf(changed)} since, so undoing this would overwrite that. Edit ${changed.length === 1 ? "it" : "them"} by hand instead.`,
      );
    }
    for (const edit of edits.data) {
      const unit = documents[edit.document]!.find((entry) => entry.id === edit.unitId)!;
      unit.text = edit.previousText;
      if (edit.previousUnverified?.length) unit.unverified = edit.previousUnverified;
      else delete unit.unverified;
    }
    if (message.previousTone) await tx.application.update({ where: { id: applicationId }, data: { tone: message.previousTone } });
    // Only once, even when two clicks race.
    const { count } = await tx.chatMessage.updateMany({ where: { id: messageId, undone: false }, data: { undone: true } });
    if (count === 0) throw new ActionError("That's already undone.");
  }, { version: { cause: VersionCause.UNDONE } });
  return edits.data.map(({ document, unitId }) => ({ document, unitId }));
}
