import "server-only";

import { z } from "zod";

import { JobStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { extractProfile } from "@/lib/ai/tasks";
import { IMPORT_PROFILE_STEPS, importedProfileSchema, type ImportedProfile, type ImportMode } from "@/lib/profile-import";
import { applyImportedProfile } from "@/lib/profile-import-apply";
import { prisma } from "@/lib/prisma";
import { MAX_RESUME_CHARACTERS } from "@/lib/resume-text";

import { cancelJob, defineJob } from "./runner";

/**
 * Sorts a resume's text into a profile (E4-10, PRO-12). Nothing goes into
 * the profile here: the result waits in the job until the user merges or
 * replaces with it, and the job, with the resume's text, is deleted then.
 */
export const importProfileJob = defineJob({
  type: "import-profile",
  input: z.object({ resume: z.string().trim().min(1).max(MAX_RESUME_CHARACTERS) }),
  result: z.object({ profile: importedProfileSchema, readWith: z.string() }),
  async run({ resume }, { step, signal }) {
    await step(IMPORT_PROFILE_STEPS[0]);
    const [provider, options] = await Promise.all([getAiProvider(), loadTaskOptions()]);
    await step(IMPORT_PROFILE_STEPS[1]);
    const { data, promptVersion } = await extractProfile(provider, { resume }, { ...options, signal });
    return { profile: data, readWith: promptVersion };
  },
});

export type ImportProfileResult = z.infer<typeof importProfileJob.result>;

/**
 * Deletes a resume reading, or all of them, with the resume's text and what
 * was read from it; one still under way is stopped first.
 */
export async function discardProfileImports(id?: string): Promise<void> {
  const where = { type: importProfileJob.type, ...(id ? { id } : {}) };
  const unfinished = await prisma.job.findMany({ where: { ...where, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } }, select: { id: true } });
  for (const job of unfinished) await cancelJob(job.id);
  await prisma.job.deleteMany({ where });
}

/**
 * Merges the profile read from a resume into the profile, or replaces it.
 * Nothing goes into the profile before this: the read profile waits in its
 * job, and is taken from there rather than from the browser. Then the job is
 * deleted, with the resume's text. Answers with what was applied.
 */
export async function applyProfileImportJob(jobId: string, mode: ImportMode): Promise<ImportedProfile> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { type: true, status: true, result: true } });
  if (job?.type !== importProfileJob.type || job.status !== JobStatus.DONE) {
    throw new ActionError("That resume isn't read yet, or it's no longer there. Choose the file again.");
  }
  const { profile } = importProfileJob.result.parse(job.result);
  await applyImportedProfile(prisma, profile, mode);
  await prisma.job.deleteMany({ where: { id: jobId } });
  return profile;
}
