import "server-only";

import { z } from "zod";

import { getAiProvider } from "@/lib/ai";
import { isAiUsable } from "@/lib/ai/config";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { prepareCall } from "@/lib/ai/tasks";
import { extractedOf } from "@/lib/application-data";
import { callPrepSchema, PREP_STATUSES, prepJobKey } from "@/lib/call-prep";
import { profileGerman } from "@/lib/german-need";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { loadFactTexts, loadProfile } from "@/lib/profile-data";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";

/**
 * Prepares an application's phone-screen pack (Call prep tab), or prepares
 * it again: the questions with her answers in German at her level and in
 * English, the salary line, stories and questions to ask, kept on the
 * application.
 */
export const prepareCallJob = defineJob({
  type: "prepare-call",
  input: z.object({ applicationId: z.string().min(1) }),
  result: callPrepSchema,
  async run({ applicationId }, { step, signal }) {
    await step("Preparing for the call");
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const [provider, options, profile, facts] = await Promise.all([getAiProvider(), loadTaskOptions(), loadProfile(), loadFactTexts(applicationId)]);
    const german = profileGerman(profile.languages);
    const { data, promptVersion } = await prepareCall(
      provider,
      {
        profile,
        extracted: extractedOf(application),
        posting: application.postingText,
        company: application.company,
        role: application.role || application.title,
        german: german === "NONE" ? "none listed" : german,
        facts,
      },
      { ...options, language: null, signal },
    );
    await prisma.application.update({ where: { id: applicationId }, data: { prep: data, prepWith: promptVersion } });
    return data;
  },
});

/** Prepare for the call: one under way is reused. */
export async function startCallPrep(applicationId: string): Promise<{ jobId: string; reused: boolean }> {
  const [unfinished] = await findUnfinishedJobs(prepJobKey(applicationId));
  if (unfinished) return { jobId: unfinished.id, reused: true };
  return { jobId: await startJob(prepareCallJob, { applicationId }, { key: prepJobKey(applicationId), applicationId }), reused: false };
}

/**
 * On reaching Screening or Interview, the pack is prepared on its own, when
 * there's none yet and Dossier's AI can write it. Never fails the status
 * change that called it.
 */
export async function prepareOnStatus(applicationId: string, status: string): Promise<void> {
  if (!(PREP_STATUSES as readonly string[]).includes(status)) return;
  try {
    const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { prepWith: true } });
    if (!application || application.prepWith || !(await isAiUsable())) return;
    await startCallPrep(applicationId);
  } catch (error) {
    logServerError("call prep", error);
  }
}
