import "server-only";

import { z } from "zod";

import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, postingKey, type FoundPosting } from "@/lib/job-search/search";
import { saveScore } from "@/lib/posting-scores";
import { loadProfile } from "@/lib/profile-data";
import { loadPostingScorer } from "@/lib/scoring";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";

/** The key of a posting's scoring job, so a second click follows the one under way. */
export const scoreJobKey = (posting: Pick<FoundPosting, "source" | "externalId">) => `posting-score:${postingKey(posting)}`;

/**
 * Score in Find jobs (#208): how well one posting fits the profile, as the
 * job agent scores them, with the scorer Settings → Scoring chose (#274). A
 * source that sent only the start of it is asked for the rest first. The
 * score is kept with the posting.
 */
export const scorePostingJob = defineJob({
  type: "posting-score",
  input: z.object({ posting: foundPostingSchema }),
  result: z.object({ score: z.number().int(), reasons: z.array(z.string()), redFlags: z.array(z.string()) }),
  async run({ posting }, { step, signal }) {
    let description = posting.description;
    if (!posting.complete) {
      await step("Getting the whole posting");
      description = (await fullText(posting)) ?? posting.description;
    }
    await step("Scoring it against your profile");
    const [score, profile] = await Promise.all([loadPostingScorer(), loadProfile()]);
    const { data, scoredWith } = await score({ ...posting, description }, profile, signal);
    await saveScore(posting, data, scoredWith);
    return data;
  },
});

/**
 * Score in New application (public issue 66): the posting as pasted, with
 * the details as read, against the profile, with the same scorer. Nothing is
 * kept: a pasted posting has no source to keep a score under.
 */
export const scorePastedPostingJob = defineJob({
  type: "pasted-score",
  input: z.object({
    posting: z.string().trim().min(1).max(100_000),
    title: z.string().max(300),
    company: z.string().max(200),
    location: z.string().max(200),
    mode: z.string().max(200),
    salary: z.string().max(200),
  }),
  result: z.object({ score: z.number().int(), reasons: z.array(z.string()), redFlags: z.array(z.string()) }),
  async run({ posting, title, company, location, mode, salary }, { step, signal }) {
    await step("Scoring it against your profile");
    const [score, profile] = await Promise.all([loadPostingScorer(), loadProfile()]);
    const remote = /\b(remote|home ?office|hybrid)\b/i.test(mode) ? true : null;
    const { data } = await score({ title, company, place: location, remote, salary, description: posting }, profile, signal);
    return data;
  },
});

/** Starts scoring a posting in the background, unless a scoring of it is under way; returns its job. */
export async function startScoring(posting: FoundPosting): Promise<string> {
  const key = scoreJobKey(posting);
  const [unfinished] = await findUnfinishedJobs(key);
  return unfinished?.id ?? (await startJob(scorePostingJob, { posting }, { key }));
}
