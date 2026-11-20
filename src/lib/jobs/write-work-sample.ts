import "server-only";

import { z } from "zod";

import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { writeWorkSample } from "@/lib/ai/tasks";
import { extractedOf } from "@/lib/application-data";
import { prisma } from "@/lib/prisma";
import { loadFactTexts, loadProfile } from "@/lib/profile-data";
import { workSampleJobKey, workSampleOf, workSampleSchema } from "@/lib/work-sample";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";

/**
 * Writes an application's work sample (Work sample tab), or writes it
 * again, in the language of its documents. A rewrite keeps whether it goes
 * into the Bewerbungsmappe.
 */
export const writeWorkSampleJob = defineJob({
  type: "write-work-sample",
  input: z.object({ applicationId: z.string().min(1) }),
  result: workSampleSchema,
  async run({ applicationId }, { step, signal }) {
    await step("Writing your first 90 days");
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const [provider, options, profile, facts] = await Promise.all([getAiProvider(), loadTaskOptions(), loadProfile(), loadFactTexts(applicationId)]);
    const { data, promptVersion } = await writeWorkSample(
      provider,
      { profile, extracted: extractedOf(application), posting: application.postingText, company: application.company, role: application.role || application.title, facts },
      { ...options, language: application.language || options.language, signal },
    );
    // Read again: she may have changed the Mappe choice while it was writing.
    const now = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, select: { workSample: true } });
    const sample = { ...data, inMappe: workSampleOf(now.workSample)?.inMappe ?? false };
    await prisma.application.update({ where: { id: applicationId }, data: { workSample: sample, workSampleWith: promptVersion } });
    return sample;
  },
});

/** Write it: one under way is reused. */
export async function startWorkSample(applicationId: string): Promise<{ jobId: string; reused: boolean }> {
  const [unfinished] = await findUnfinishedJobs(workSampleJobKey(applicationId));
  if (unfinished) return { jobId: unfinished.id, reused: true };
  return { jobId: await startJob(writeWorkSampleJob, { applicationId }, { key: workSampleJobKey(applicationId), applicationId }), reused: false };
}
