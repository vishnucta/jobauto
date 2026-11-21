import "server-only";

import { z } from "zod";

import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { prepareCall } from "@/lib/ai/tasks";
import { callAnswers, callPrepSchema } from "@/lib/call-prep";
import { profileGerman } from "@/lib/german-need";
import { loadProfile } from "@/lib/profile-data";
import { latestRole } from "@/lib/job-search/search";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";

// Call prep's general practice (jobauto fork, once Interview practice): the
// call prep pack before there's a call, from her profile alone, for the kind
// of job she's after. The
// questions every first call in Germany asks are the same; practising them
// now means the first real call isn't the first time she says the answers.
// Kept in Settings (practicePrep), one at a time.

export const PRACTICE_JOB_KEY = "practice-prep";

export const preparePracticeJob = defineJob({
  type: "prepare-practice",
  input: z.object({}),
  result: callPrepSchema,
  async run(_input, { step, signal }) {
    await step("Preparing your practice call");
    const [provider, options, profile, settings] = await Promise.all([getAiProvider(), loadTaskOptions(), loadProfile(), loadSettings()]);
    const german = profileGerman(profile.languages);
    const { data, promptVersion } = await prepareCall(
      provider,
      {
        profile,
        extracted: null,
        posting: "",
        company: "",
        role: profile.basics.headline.trim() || latestRole(profile.experience.map((entry) => ({ ...entry, current: entry.current ?? false }))),
        german: german === "NONE" ? "none listed" : german,
        facts: [],
        // Her standard answers, as a real call's pack uses them (jobauto fork).
        answers: callAnswers(settings.applyAnswers),
      },
      { ...options, language: null, signal },
    );
    await saveSettings({ practicePrep: data, practicePrepWith: promptVersion });
    return data;
  },
});

/** Prepare a practice call: one under way is reused. */
export async function startPractice(): Promise<{ jobId: string; reused: boolean }> {
  const [unfinished] = await findUnfinishedJobs(PRACTICE_JOB_KEY);
  if (unfinished) return { jobId: unfinished.id, reused: true };
  return { jobId: await startJob(preparePracticeJob, {}, { key: PRACTICE_JOB_KEY }), reused: false };
}
