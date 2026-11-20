// Today's three (jobauto fork): the dashboard opens with the three things
// that get applications out today, so a session ends with something sent
// rather than another search. Drafts she started come first, then the job
// agent's drafts waiting for review, then its best matches still to
// prepare. Never more than three: a short list gets done.

export const TODAY_COUNT = 3;

export type TodayItem =
  /** A draft of hers: finish it and send it. */
  | { kind: "finish"; applicationId: string; title: string; company: string }
  /** The agent's draft, ready: review it and send it. */
  | { kind: "review"; applicationId: string; title: string; company: string; score: number }
  /** A strong match with no draft yet: prepare it (jobId while one is being written). */
  | { kind: "prepare"; candidateId: string; title: string; company: string; score: number; url: string; jobId: string | null };

export type TodayInput = {
  /** Her drafts, newest first. */
  drafts: { id: string; title: string; company: string }[];
  /** The agent's drafts waiting for review. */
  reviews: { applicationId: string; title: string; company: string; score: number }[];
  /** Matches at or above the minimum score, with no draft yet or one being written. */
  matches: { id: string; title: string; company: string; score: number; url: string; jobId: string | null }[];
};

const byScore = <T extends { score: number }>(items: readonly T[]) => [...items].sort((a, b) => b.score - a.score);

/** The three to do today, in the order that gets most out soonest. */
export function todaysThree({ drafts, reviews, matches }: TodayInput): TodayItem[] {
  return [
    ...drafts.map((draft): TodayItem => ({ kind: "finish", applicationId: draft.id, title: draft.title, company: draft.company })),
    ...byScore(reviews).map((review): TodayItem => ({ kind: "review", ...review })),
    ...byScore(matches).map(({ id, ...match }): TodayItem => ({ kind: "prepare", candidateId: id, ...match })),
  ].slice(0, TODAY_COUNT);
}
