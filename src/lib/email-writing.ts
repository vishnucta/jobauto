import "server-only";

import { DocumentKind, JobStatus, VersionCause } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { isAiConfigured } from "@/lib/ai/config";
import { unitsSchema } from "@/lib/application-data";
import { updateDocuments } from "@/lib/document-units";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { emailJobKey, writeEmailJob } from "@/lib/jobs/write-email";
import { prisma } from "@/lib/prisma";

// The application's email written by the AI, on its Email tab: "Write the
// email", "Rewrite" and Undo after a rewrite, from the page or from Claude
// through the connector (jobauto fork).

const GONE = "That application no longer exists.";
const PART_GONE = "That part of the document no longer exists. Reload the page to see what's there now.";

/**
 * Writes the application's email in the background and returns the job's
 * id. Asking again while it's being written follows the same job.
 */
export async function writeApplicationEmail(applicationId: string): Promise<string> {
  if (!(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError(GONE);
  if (!(await isAiConfigured())) throw new ActionError("That needs an AI provider. Choose one in Settings → AI provider.");
  const [running] = await findUnfinishedJobs(emailJobKey(applicationId));
  return running?.id ?? startJob(writeEmailJob, { applicationId }, { key: emailJobKey(applicationId), applicationId });
}

/** The application's last finished email writing, the one Undo after a rewrite would put back; null when there's none. */
export async function lastEmailWriting(applicationId: string): Promise<string | null> {
  const job = await prisma.job.findFirst({
    where: { key: emailJobKey(applicationId), status: JobStatus.DONE },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return job?.id ?? null;
}

/**
 * Undo after a rewrite: puts back the email the writing `jobId` replaced,
 * unless it has changed again since.
 */
export async function putBackEmail(applicationId: string, jobId: string): Promise<void> {
  const job = await prisma.job.findFirst({ where: { id: jobId, key: emailJobKey(applicationId), status: JobStatus.DONE }, select: { result: true } });
  const result = writeEmailJob.result.safeParse(job?.result);
  const previous = result.success ? result.data.previous : null;
  if (!result.success || !previous) throw new ActionError("There's nothing to undo.");

  const same = (a: unknown, b: unknown) => JSON.stringify(unitsSchema.parse(a)) === JSON.stringify(unitsSchema.parse(b));
  await updateDocuments(applicationId, async (documents) => {
    const current = documents[DocumentKind.EMAIL];
    if (!current) throw new ActionError(PART_GONE);
    if (!same(current, result.data.units)) {
      throw new ActionError("The email has changed since, so this can't be undone. Earlier versions are in its history.");
    }
    documents[DocumentKind.EMAIL] = previous;
  }, { version: { cause: VersionCause.UNDONE } });
}
