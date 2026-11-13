import "server-only";

import { AgentCandidateStatus, JobStatus } from "@/generated/prisma/enums";
import { formatDateTime } from "@/lib/dates";
import { postedAgo, type PostingOrigin } from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import { lastKnownTimeZone } from "@/lib/time-zone";
import type { AgentSearchRun } from "@/lib/settings";

import { stringsOf } from "./candidates";
import { AGENT_JOB_KEY } from "./jobs";
import { agentSetupProblem } from "./run";
import { interruptedRunMessage, nextSourceBudgetAt, sourceRequestsInPastDay } from "./runs";
import { nextAgentRun } from "./schedule";
import { listAgentSearches } from "./searches";
import type { SavedAgentSearch } from "./search";
import { isAgentScanRunning } from "./scan-lock";

// What the Agent screen shows (E16-6).

export type AgentCandidateView = {
  /** Historical names survive renames/deletion; searchId can be null. */
  searches: { searchId: string | null; searchName: string }[];
  id: string;
  title: string;
  company: string;
  /** "Rotterdam · Remote · €70k", what's known of them. */
  facts: string;
  /** "Posted 2 days ago · via LinkedIn on JSearch". */
  origin: string;
  source: PostingOrigin;
  url: string;
  score: number;
  reasons: string[];
  redFlags: string[];
  /** Why the last try at a draft failed. */
  error: string | null;
  /** The draft, once there is one. */
  applicationId: string | null;
  /** The job preparing its draft, while one is queued or running. */
  draftJobId: string | null;
};

export type AgentView = {
  /** Recurring search collection, including disabled searches, in run order. */
  searches: SavedAgentSearch[];
  sourceRequestsUsed: number;
  nextEligibility: string;
  timeZone: string;
  searchHistory: (AgentSearchRun & { at: string; batchMessage: string | null })[];
  searchResults: AgentSearchRun[];
  enabled: boolean;
  autoDraft: boolean;
  minScore: number;
  maxScores: number;
  maxDrafts: number;
  /** Why it can't run: no search, scorer, source or key; null when it's set up. */
  setupProblem: string | null;
  /** Which settings section fixes it. */
  setupSection: "agent" | "ai" | "jobs" | "scoring" | null;
  /** The daily limit is used up. */
  limitReached: boolean;
  lastRun: { at: string; message: string | null } | null;
  /** In the user's zone; null while the agent is off. */
  nextRun: string | null;
  /** A run queued or running, to follow. */
  runJobId: string | null;
  drafts: AgentCandidateView[];
  /** At or above the minimum score, best first. */
  scored: AgentCandidateView[];
  /** Below it: kept so they don't come back, shown on request. */
  belowMinimum: AgentCandidateView[];
};

/** The Agent item's badge (E16-6): what's waiting for a look. */
export async function countAgentQueue(): Promise<number> {
  const { agentMinScore } = await loadSettings();
  return prisma.agentCandidate.count({
    where: {
      OR: [
        { status: AgentCandidateStatus.SCORED, score: { gte: agentMinScore } },
        { status: AgentCandidateStatus.DRAFTED, applicationId: { not: null } },
      ],
    },
  });
}

/** "Today" and "Yesterday" in a sentence; "2 days ago" or "15 Oct" as they are. */
const posted = (ago: string) => (ago === "Today" || ago === "Yesterday" ? ago.toLowerCase() : ago);

const sectionOf = (problem: string): AgentView["setupSection"] =>
  problem.includes("AI provider") ? "ai" : problem.includes("Scoring") ? "scoring" : problem.includes("Job search") ? "jobs" : "agent";

export async function loadAgentView(now = new Date()): Promise<AgentView> {
  const [settings, timeZone, candidates, draftJobs, runJobs, searches] = await Promise.all([
    loadSettings(),
    lastKnownTimeZone(),
    prisma.agentCandidate.findMany({
      where: { status: { in: [AgentCandidateStatus.SCORED, AgentCandidateStatus.DRAFTING, AgentCandidateStatus.DRAFTED] } },
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
      include: { searches: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { searchId: true, searchName: true } } },
    }),
    prisma.job.findMany({
      where: { type: "agent-draft", status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
      select: { id: true, key: true },
    }),
    prisma.job.findMany({ where: { key: AGENT_JOB_KEY, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } }, select: { id: true }, take: 1 }),
    listAgentSearches(),
  ]);
  // Present an interrupted reservation even when quota prevents another run.
  // This is read-only: taking the scan lock on render can reject the very job
  // a Run now action has just started. The next scan persists reconciliation
  // while owning execution. A queued/live job keeps its pending outcome.
  if (!runJobs.length && settings.agentRuns.some((run) => run.message === null) && !await isAgentScanRunning()) {
    for (const run of settings.agentRuns) if (run.message === null) run.message = interruptedRunMessage(run);
  }
  const draftJob = new Map(draftJobs.map((job) => [job.key?.replace(/^agent-candidate:/, ""), job.id]));

  const setupProblem = await agentSetupProblem();

  const view = (candidate: (typeof candidates)[number]): AgentCandidateView => ({
    searches: candidate.searches,
    id: candidate.id,
    title: candidate.title.trim() || "Untitled posting",
    company: candidate.company.trim(),
    facts: [candidate.place, candidate.remote ? "Remote" : "", candidate.salary].filter(Boolean).join(" · "),
    origin: [
      candidate.postedAt ? `Posted ${posted(postedAgo(candidate.postedAt.toISOString(), now))}` : "",
      [candidate.via ? `via ${candidate.via}` : "", `on ${SOURCE_INFO[candidate.source].name}`].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(" · "),
    source: candidate.source,
    url: candidate.url,
    score: candidate.score,
    reasons: stringsOf(candidate.reasons),
    redFlags: stringsOf(candidate.redFlags),
    error: candidate.error,
    applicationId: candidate.applicationId,
    draftJobId: draftJob.get(candidate.id) ?? null,
  });
  const drafts = candidates.filter((candidate) => candidate.status === AgentCandidateStatus.DRAFTED && candidate.applicationId).map(view);
  const waiting = candidates.filter((candidate) => candidate.status !== AgentCandidateStatus.DRAFTED);
  const last = settings.agentRuns[0];
  const requests = searches.filter((search) => search.enabled).length;
  const eligible = nextSourceBudgetAt(settings.agentRuns, now, Math.max(1, requests));

  return {
    searches,
    sourceRequestsUsed: sourceRequestsInPastDay(settings.agentRuns, now),
    nextEligibility: eligible > now ? formatDateTime(eligible, timeZone, now) : "Now",
    timeZone,
    searchHistory: searches.flatMap((search) => {
      const run = settings.agentRuns.find((run) => run.searches?.some((result) => result.searchId === search.id));
      const result = run?.searches?.find((result) => result.searchId === search.id);
      return run && result ? [{ ...result, at: formatDateTime(new Date(run.at), timeZone, now), batchMessage: run.message }] : [];
    }),
    searchResults: last?.searches ?? [],
    enabled: settings.agentEnabled,
    autoDraft: settings.agentAutoDraft,
    minScore: settings.agentMinScore,
    maxScores: settings.agentMaxScores,
    maxDrafts: settings.agentMaxDrafts,
    setupProblem,
    setupSection: setupProblem ? sectionOf(setupProblem) : null,
    limitReached: eligible > now,
    lastRun: last ? { at: formatDateTime(new Date(last.at), timeZone, now), message: last.message } : null,
    nextRun: settings.agentEnabled ? formatDateTime(nextAgentRun(now, settings.agentHour, timeZone, settings.agentRuns, requests), timeZone, now) : null,
    runJobId: runJobs[0]?.id ?? null,
    drafts,
    scored: waiting.filter((candidate) => candidate.score >= settings.agentMinScore).map(view),
    belowMinimum: waiting.filter((candidate) => candidate.score < settings.agentMinScore).map(view),
  };
}
