import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";

// Private notes on an application (E8-9, APP-14), from its Notes tab and
// from Claude through the connector (jobauto fork). They never go into a
// prompt of Dossier's own: no AI task reads the Note table. Claude reads them
// through the connector only when the user asks it to (list_notes).

const GONE = "That application no longer exists.";
const NOTE_GONE = "That note no longer exists.";

/** A note as written: trimmed, and not empty. */
export const noteBody = z.string().trim().min(1, "Write something first.").max(5000);

export type ApplicationNote = { id: string; body: string; createdAt: Date; updatedAt: Date };

const NOTE_FIELDS = { id: true, body: true, createdAt: true, updatedAt: true } as const;

export async function addApplicationNote(applicationId: string, body: string): Promise<ApplicationNote> {
  if (!(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError(GONE);
  return prisma.note.create({ data: { applicationId, body }, select: NOTE_FIELDS });
}

export async function updateApplicationNote(applicationId: string, noteId: string, body: string): Promise<void> {
  const { count } = await prisma.note.updateMany({ where: { id: noteId, applicationId }, data: { body } });
  if (count === 0) throw new ActionError(NOTE_GONE);
}

/** Deletes a note at once and returns it, for `restoreApplicationNote` to bring back with its dates (Undo on the toast). */
export async function deleteApplicationNote(applicationId: string, noteId: string): Promise<ApplicationNote> {
  const note = await prisma.note.findFirst({ where: { id: noteId, applicationId }, select: NOTE_FIELDS });
  if (!note) throw new ActionError(NOTE_GONE);
  await prisma.note.delete({ where: { id: note.id } });
  return note;
}

export async function restoreApplicationNote(applicationId: string, { body, createdAt, updatedAt }: Omit<ApplicationNote, "id">): Promise<void> {
  if (!(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError(GONE);
  await prisma.note.create({ data: { applicationId, body, createdAt, updatedAt } });
}
