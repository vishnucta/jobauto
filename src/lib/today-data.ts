import "server-only";

import { AgentCandidateStatus, JobStatus } from "@/generated/prisma/enums";
import { candidateCoverage } from "@/lib/agent/candidates";
import { draftJobKey } from "@/lib/agent/draft";
import { passes } from "@/lib/posting-coverage";
import { prisma } from "@/lib/prisma";
import { agentCoversOf } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";

import { TODAY_COUNT, todaysThree, type TodayItem } from "./today";

/** How many of the agent's scored postings are weighed for the three; its own screen weighs as many (agent/view.ts). */
const WEIGHED = 300;

/**
 * Today's three (today.ts), from her drafts, the agent's drafts and its
 * matches: what it scored that passes its cut-off (E32-2), never one a run
 * skipped.
 */
export async function loadToday(): Promise<TodayItem[]> {
  const settings = await loadSettings();
  const covers = agentCoversOf(settings);
  const coverage = { covered: true, requirements: true, mustMissing: true, createdAt: true } as const;
  const [drafts, reviews, matches, writing] = await Promise.all([
    prisma.application.findMany({
      where: { status: "DRAFT", awaitingReview: false, archivedAt: null },
      orderBy: { createdAt: "desc" },
      take: TODAY_COUNT,
      select: { id: true, title: true, company: true, role: true },
    }),
    prisma.agentCandidate.findMany({
      where: { status: AgentCandidateStatus.DRAFTED, applicationId: { not: null } },
      select: { applicationId: true, title: true, company: true, ...coverage },
    }),
    prisma.agentCandidate.findMany({
      where: { status: { in: [AgentCandidateStatus.SCORED, AgentCandidateStatus.DRAFTING] }, skipReason: null },
      orderBy: { createdAt: "desc" },
      take: WEIGHED,
      select: { id: true, title: true, company: true, url: true, ...coverage },
    }),
    prisma.job.findMany({ where: { type: "agent-draft", status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } }, select: { id: true, key: true } }),
  ]);
  const jobFor = new Map(writing.map((job) => [job.key, job.id]));
  return todaysThree({
    drafts: drafts.map((draft) => ({ id: draft.id, title: draft.role.trim() || draft.title.trim() || "Untitled application", company: draft.company.trim() })),
    reviews: reviews.map((review) => ({
      applicationId: review.applicationId!,
      title: review.title.trim() || "Untitled posting",
      company: review.company.trim(),
      coverage: candidateCoverage(review),
      at: review.createdAt.getTime(),
    })),
    matches: matches
      .filter((match) => passes(candidateCoverage(match), covers))
      .map((match) => ({
        id: match.id,
        title: match.title.trim() || "Untitled posting",
        company: match.company.trim(),
        coverage: candidateCoverage(match),
        at: match.createdAt.getTime(),
        url: match.url,
        jobId: jobFor.get(draftJobKey(match.id)) ?? null,
      })),
  });
}
