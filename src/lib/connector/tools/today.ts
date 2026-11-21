import "server-only";

import { z } from "zod";

import { needsYouHref, type NeedsYouItem } from "@/lib/dashboard";
import { loadDashboard } from "@/lib/dashboard-data";
import { waitingByApplication } from "@/lib/google/inbox-data";
import { fitWords, type Coverage } from "@/lib/posting-coverage";
import { prisma } from "@/lib/prisma";
import { loadScoringOff } from "@/lib/scoring-off-data";
import { loadSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";
import { lastKnownTimeZone } from "@/lib/time-zone";
import { loadToday } from "@/lib/today-data";
import type { TodayItem } from "@/lib/today";

import { text, type ToolContext } from "../kit";

// The dashboard (jobauto fork): what she'd ask Claude first, "what should I
// do today?", answered as the dashboard answers it. Today's three and Needs
// you come from the same functions the dashboard draws, with links to the
// screen each row opens, and the scoring-off notice while it shows.

/** What each of Today's three asks of her, as its row says it. */
const WHAT: Record<TodayItem["kind"], string> = {
  finish: "Your draft: finish it and send it",
  review: "The agent's draft: read it and send it",
  prepare: "A strong match: let the agent write the draft",
};

/** "3 of 5" and "Good fit", when the posting has requirements to count. */
const coverageLine = (coverage: Coverage) => (coverage.total > 0 ? { covered: `${coverage.hit} of ${coverage.total}`, fit: fitWords(coverage) } : {});

export function registerTodayTools({ server, linkTo }: ToolContext): void {
  server.registerTool(
    "get_today",
    {
      title: "What to do today",
      description:
        "The dashboard's Today's three (the three things that get applications out today: the user's drafts, the job agent's drafts, then its best matches still to write) " +
        "and Needs you (what's due this week first, soonest on top, then what has no date), each with the ids the other tools take and a link to the screen it opens. " +
        "Use it when the user asks what to do next.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [settings, timeZone, replies] = await Promise.all([loadSettings(), lastKnownTimeZone(), waitingByApplication().catch(() => undefined)]);
      const [figures, three, scoringOff] = await Promise.all([loadDashboard({ quietDays: settings.quietDays, timeZone, replies }), loadToday(), loadScoringOff()]);
      // An agent's draft is acted on by its find, as on the Agent screen.
      const reviews = three.flatMap((item) => (item.kind === "review" ? [item.applicationId] : []));
      const finds = reviews.length > 0 ? await prisma.agentCandidate.findMany({ where: { applicationId: { in: reviews } }, select: { id: true, applicationId: true } }) : [];
      const findOf = new Map(finds.map((find) => [find.applicationId, find.id]));
      return text({
        scoring_off: scoringOff
          ? {
              message: `${scoringOff.title} ${scoringOff.body}`,
              next: "Ask the user which levels the profile is for and save them with set_profile_levels.",
              link: linkTo(scoringOff.href),
            }
          : undefined,
        todays_three: three.map((item, index) => todayLine(item, index + 1, findOf, linkTo)),
        nothing_waiting: three.length === 0 ? "Nothing is waiting. Run the job agent, or find a posting and start an application." : undefined,
        due_this_week: figures.needsYou.filter((item) => item.soon).length,
        needs_you: figures.needsYou.map((item) => needsYouLine(item, linkTo)),
        link: linkTo("/"),
      });
    },
  );
}

/** One of Today's three, with what acts on it. */
function todayLine(item: TodayItem, number: number, findOf: ReadonlyMap<string | null, string>, linkTo: ToolContext["linkTo"]) {
  const base = { number, what: WHAT[item.kind], title: item.title, company: item.company || undefined };
  switch (item.kind) {
    case "finish":
      return { ...base, application_id: item.applicationId, link: linkTo(`/applications/${item.applicationId}`) };
    case "review":
      return {
        ...base,
        ...coverageLine(item.coverage),
        application_id: item.applicationId,
        find_id: findOf.get(item.applicationId),
        next: "get_job_agent with this find_id reads the draft; act_on_agent_find approve moves it into Applications.",
        link: linkTo(`/applications/${item.applicationId}`),
      };
    case "prepare":
      return {
        ...base,
        ...coverageLine(item.coverage),
        find_id: item.candidateId,
        posting_url: item.url || undefined,
        // Being written already: follow it rather than starting another.
        task_id: item.jobId ?? undefined,
        next: item.jobId ? "check_task follows the draft being written." : "act_on_agent_find prepare_draft has Dossier write the draft.",
        link: linkTo("/agent"),
      };
  }
}

/** One row of Needs you, with the link its button opens. */
function needsYouLine(item: NeedsYouItem, linkTo: ToolContext["linkTo"]) {
  return {
    application_id: item.id,
    company: item.company || undefined,
    role: item.role,
    status: statusInfo(item.status).label,
    reason: item.reason,
    due: item.due ?? undefined,
    this_week: item.soon,
    action: item.action,
    link: linkTo(needsYouHref(item)),
  };
}
