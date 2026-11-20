import "server-only";

import { AgentCandidateStatus, JobStatus } from "@/generated/prisma/enums";
import { draftJobKey } from "@/lib/agent/draft";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";

import { TODAY_COUNT, todaysThree, type TodayItem } from "./today";

/** Today's three (today.ts), from her drafts, the agent's drafts and its matches. */
export async function loadToday(): Promise<TodayItem[]> {
  const { agentMinScore } = await loadSettings();
  const [drafts, reviews, matches, writing] = await Promise.all([
    prisma.application.findMany({
      where: { status: "DRAFT", awaitingReview: false, archivedAt: null },
      orderBy: { createdAt: "desc" },
      take: TODAY_COUNT,
      select: { id: true, title: true, company: true, role: true },
    }),
    prisma.agentCandidate.findMany({
      where: { status: AgentCandidateStatus.DRAFTED, applicationId: { not: null } },
      orderBy: { score: "desc" },
      take: TODAY_COUNT,
      select: { applicationId: true, title: true, company: true, score: true },
    }),
    prisma.agentCandidate.findMany({
      where: { status: { in: [AgentCandidateStatus.SCORED, AgentCandidateStatus.DRAFTING] }, score: { gte: agentMinScore } },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      take: TODAY_COUNT,
      select: { id: true, title: true, company: true, score: true, url: true },
    }),
    prisma.job.findMany({ where: { type: "agent-draft", status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } }, select: { id: true, key: true } }),
  ]);
  const jobFor = new Map(writing.map((job) => [job.key, job.id]));
  return todaysThree({
    drafts: drafts.map((draft) => ({ id: draft.id, title: draft.role.trim() || draft.title.trim() || "Untitled application", company: draft.company.trim() })),
    reviews: reviews.map((review) => ({ applicationId: review.applicationId!, title: review.title.trim() || "Untitled posting", company: review.company.trim(), score: review.score })),
    matches: matches.map((match) => ({ ...match, title: match.title.trim() || "Untitled posting", company: match.company.trim(), jobId: jobFor.get(draftJobKey(match.id)) ?? null })),
  });
}
