import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { linkKey, normalText, type FoundPosting } from "@/lib/job-search/search";
import type { Breakdown } from "@/lib/scoring/factors";
import { coverageOf, type Coverage } from "@/lib/posting-coverage";

// The job agent's candidates (E16): postings it found and scored. A dismissed
// one stays, so the posting never comes back, but keeps only what dedupe
// needs.

/**
 * The dedupe key: a hash of the link without tracking parameters, else of
 * company, title and place, so the same job found through another source or
 * in a later run matches. A posting with none of those falls back to its
 * source's id.
 */
export function agentDedupeKey(posting: Pick<FoundPosting, "source" | "externalId" | "url" | "title" | "company" | "place">): string {
  const link = linkKey(posting.url);
  const facts = [posting.company, posting.title, posting.place].map(normalText);
  const basis = link ? `link:${link}` : facts.some(Boolean) ? `job:${facts.join("|")}` : `id:${posting.source}:${posting.externalId}`;
  return createHash("sha256").update(basis).digest("hex");
}

/**
 * Every dedupe key a posting matches by (jobauto fork): its own, then one
 * for each other place it's listed to apply at, so a candidate kept under a
 * link the posting no longer leads with still matches it.
 */
export function agentDedupeKeys(posting: Pick<FoundPosting, "source" | "externalId" | "url" | "title" | "company" | "place" | "applyOptions">): string[] {
  const others = (posting.applyOptions ?? []).map((option) => linkKey(option.url)).filter((link) => link && link !== linkKey(posting.url));
  return [...new Set([agentDedupeKey(posting), ...others.map((link) => createHash("sha256").update(`link:${link}`).digest("hex"))])];
}

/** A posting as a new candidate, with its score. */
export function candidateData(posting: FoundPosting, score: { score: number; reasons: string[]; redFlags: string[]; breakdown?: Breakdown | null }): Prisma.AgentCandidateCreateInput {
  const coverage = coverageOf(score);
  return {
    source: posting.source,
    externalId: posting.externalId,
    title: posting.title,
    company: posting.company,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary,
    postedAt: posting.postedAt ? new Date(posting.postedAt) : null,
    url: posting.url,
    via: posting.via,
    description: posting.description,
    complete: posting.complete,
    score: score.score,
    reasons: score.reasons,
    redFlags: score.redFlags,
    covered: coverage.hit,
    requirements: coverage.total,
    mustMissing: coverage.mustMissing,
    dedupeKey: agentDedupeKey(posting),
  };
}

/**
 * What a dismissed candidate gives up (#191): everything but its source, the
 * source's id, its dedupe key, title and company, which say what it was.
 */
export const DISMISSED_TRIM = {
  place: "",
  remote: null,
  salary: "",
  postedAt: null,
  url: "",
  via: "",
  description: "",
  complete: false,
  reasons: [],
  redFlags: [],
  error: null,
  applicationId: null,
} satisfies Prisma.AgentCandidateUncheckedUpdateInput;

/** A JSON list of strings, as reasons and red flags are stored; anything else reads as none. */
export function stringsOf(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A candidate's coverage, as stored with it. */
export const candidateCoverage = (candidate: { covered: number; requirements: number; mustMissing: number }): Coverage => ({
  hit: candidate.covered,
  total: candidate.requirements,
  mustMissing: candidate.mustMissing,
});

/**
 * Why a run left a posting unscored (E32-5, PL3). Under the cut-off isn't kept: it follows the cut-off as it is now.
 * "german" (jobauto fork): it asks for far more German than the profile has, so no AI was spent on it.
 */
export type SkipReason = "budget" | "known" | "dismissed" | "german";

/** A skip as the Skipped tab says it. */
export const SKIP_WORDS: Record<SkipReason, string> = {
  budget: "Past the run's scoring limit: it stays in Positions unscored",
  known: "Already in Positions: saved, applied for or archived",
  dismissed: "Dismissed earlier",
  german: "Needs more German than your profile has: not scored",
};
