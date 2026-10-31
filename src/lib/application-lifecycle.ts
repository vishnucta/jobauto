import "server-only";

import { ActionError } from "@/lib/action";
import { deleteApplyRuns } from "@/lib/apply/files";
import { cancelApplicationJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";

// Archiving and deleting an application (E9-5, LST-8), from its page, a card
// or a table row (src/lib/application-actions.ts), and from Claude through
// the connector (jobauto fork).

const GONE = "That application no longer exists.";

/**
 * Archives an application, or brings it back. Archived ones leave the board
 * but still count on the dashboard. Tidying up isn't news, so "Updated"
 * stays as it was.
 */
export async function setApplicationArchived(applicationId: string, archived: boolean): Promise<void> {
  const current = await prisma.application.findUnique({ where: { id: applicationId }, select: { updatedAt: true } });
  if (!current) throw new ActionError(GONE);
  await prisma.application.update({
    where: { id: applicationId },
    data: { archivedAt: archived ? new Date() : null, updatedAt: current.updatedAt },
  });
}

/**
 * Deletes an application with its documents and their versions, chat,
 * notes, status history and background jobs, whose inputs and results hold
 * the posting and the documents too (the database cascades), and its apply
 * runs with the PDFs and screenshots they kept.
 */
export async function eraseApplication(applicationId: string): Promise<void> {
  await cancelApplicationJobs(applicationId);
  const runs = await prisma.applyAttempt.findMany({ where: { applicationId }, select: { id: true } });
  const { count } = await prisma.application.deleteMany({ where: { id: applicationId } });
  if (count === 0) throw new ActionError(GONE);
  await deleteApplyRuns(runs.map((run) => run.id));
}
