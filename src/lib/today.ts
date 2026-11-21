// Today's three (jobauto fork): the dashboard opens with the three things
// that get applications out today, so a session ends with something sent
// rather than another search. Drafts she started come first, then the job
// agent's drafts waiting for review, then its best matches still to
// prepare. Never more than three: a short list gets done. The agent's come
// best fit first, by how much of each posting's requirements the profile
// covers (posting-coverage.ts), as 1.15's agent orders them.

import { byBestFit, type Coverage } from "@/lib/posting-coverage";

export const TODAY_COUNT = 3;

export type TodayItem =
  /** A draft of hers: finish it and send it. */
  | { kind: "finish"; applicationId: string; title: string; company: string }
  /** The agent's draft, ready: review it and send it. */
  | { kind: "review"; applicationId: string; title: string; company: string; coverage: Coverage }
  /** A strong match with no draft yet: prepare it (jobId while one is being written). */
  | { kind: "prepare"; candidateId: string; title: string; company: string; coverage: Coverage; url: string; jobId: string | null };

export type TodayInput = {
  /** Her drafts, newest first. */
  drafts: { id: string; title: string; company: string }[];
  /** The agent's drafts waiting for review; `at` is when it was found. */
  reviews: { applicationId: string; title: string; company: string; coverage: Coverage; at: number }[];
  /** Matches that pass the agent's cut-off, with no draft yet or one being written. */
  matches: { id: string; title: string; company: string; coverage: Coverage; at: number; url: string; jobId: string | null }[];
};

const bestFirst = <T extends { coverage: Coverage; at: number }>(items: readonly T[]) => [...items].sort(byBestFit);

/** The three to do today, in the order that gets most out soonest. */
export function todaysThree({ drafts, reviews, matches }: TodayInput): TodayItem[] {
  return [
    ...drafts.map((draft): TodayItem => ({ kind: "finish", applicationId: draft.id, title: draft.title, company: draft.company })),
    ...bestFirst(reviews).map(({ applicationId, title, company, coverage }): TodayItem => ({ kind: "review", applicationId, title, company, coverage })),
    ...bestFirst(matches).map(({ id, title, company, coverage, url, jobId }): TodayItem => ({ kind: "prepare", candidateId: id, title, company, coverage, url, jobId })),
  ].slice(0, TODAY_COUNT);
}
