import "server-only";

import { z } from "zod";

import { AgentCandidateStatus, DocumentKind, StartupStatus } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { stringsOf } from "@/lib/agent/candidates";
import { approveCandidate, dismissCandidate, draftJobKey, restoreDismissedCandidate, startCandidateDraft } from "@/lib/agent/draft";
import { startAgentRun } from "@/lib/agent/jobs";
import { updateAgentSettings } from "@/lib/agent/settings";
import { loadAgentView, type AgentCandidateView } from "@/lib/agent/view";
import { formatDateTime } from "@/lib/dates";
import { countryCodeFor } from "@/lib/job-search/countries";
import { POSTED_WITHIN, postingKey, RADII_KM, type PostedWithin, type SearchQuery } from "@/lib/job-search/search";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import type { SettingsData } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";
import { placeOf } from "@/lib/startups/place";
import { startStartupsRefresh, STARTUPS_JOB_KEY } from "@/lib/startups/refresh";
import { getStartup, linkStartupApplication, listStartups, lookUpStartup, removeStartup, startupPostingText, updateStartup } from "@/lib/startups/store";
import { STARTUP_PLACES, STARTUP_SORTS, STARTUP_SOURCE_INFO, STARTUP_SOURCES, startupFilterHref, startupFilterSchema, type StartupView } from "@/lib/startups/types";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { documentText, failure, started, text, type ToolContext } from "../kit";

// The job agent and Startups (jobauto fork): what the Agent and Startups
// screens show and do, and Settings → Job agent. As on the screens, nothing
// here sends anything: an approved draft is a Draft application, and the
// user writes to a startup themselves.

const POSTED = POSTED_WITHIN.map((option) => option.value) as [PostedWithin, ...PostedWithin[]];
const GONE = "That startup is no longer in the list.";

/** Where a find stands, in words. */
const FIND_STATUS: Record<AgentCandidateStatus, string> = {
  SCORED: "Waiting for a look",
  DRAFTING: "Draft being prepared",
  DRAFTED: "Draft ready for review",
  APPROVED: "Approved: in Applications",
  DISMISSED: "Dismissed",
};

/** A refusal from the library, written for the user, as the failure Claude reads; anything else is thrown on. */
function refusal(error: unknown) {
  if (error instanceof ActionError) return failure(error.message);
  throw error;
}

/** The agent's settings, named as update_job_agent takes them. */
function agentSettings(settings: SettingsData, timeZone: string) {
  const query = settings.agentQuery;
  return {
    enabled: settings.agentEnabled,
    keywords: query.keywords,
    place: query.place,
    country: query.country,
    radius_km: query.radiusKm,
    remote_only: query.remoteOnly,
    posted_within: query.postedWithin,
    hour: settings.agentHour,
    time_zone: timeZone,
    min_score: settings.agentMinScore,
    max_scores: settings.agentMaxScores,
    auto_draft: settings.agentAutoDraft,
    max_drafts: settings.agentMaxDrafts,
  };
}

/** A find as Claude sees it in a list. */
const findLine = (find: AgentCandidateView) => ({
  find_id: find.id,
  title: find.title,
  company: find.company || undefined,
  facts: find.facts || undefined,
  origin: find.origin || undefined,
  url: find.url || undefined,
  score: find.score,
  reasons: find.reasons,
  red_flags: find.redFlags.length > 0 ? find.redFlags : undefined,
  error: find.error ?? undefined,
  drafting_task_id: find.draftJobId ?? undefined,
});

/** Finds dismissed lately whose posting Find jobs still keeps, so restore can put them back. */
async function restorableFinds() {
  const dismissed = await prisma.agentCandidate.findMany({
    where: { status: AgentCandidateStatus.DISMISSED },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, title: true, company: true, source: true, externalId: true, updatedAt: true },
  });
  if (dismissed.length === 0) return [];
  const kept = await prisma.posting.findMany({ where: { OR: dismissed.map(({ source, externalId }) => ({ source, externalId })) }, select: { source: true, externalId: true } });
  const keys = new Set(kept.map(postingKey));
  return dismissed
    .filter((find) => keys.has(postingKey(find)))
    .map((find) => ({ find_id: find.id, title: find.title.trim() || "Untitled posting", company: find.company.trim() || undefined, dismissed: find.updatedAt.toISOString().slice(0, 10) }));
}

/** A startup as Claude sees it, with the addresses it publishes: people's own only when it's read on its own, a list just counts them. */
function startupLine(startup: StartupView, { people = false }: { people?: boolean } = {}) {
  const emails = people ? startup.emails : startup.emails.filter((entry) => !entry.onRequest);
  return {
    id: startup.id,
    company: startup.company,
    website: startup.website || undefined,
    found_on: `${STARTUP_SOURCE_INFO[startup.source].name} · ${STARTUP_SOURCE_INFO[startup.source].kind}`,
    summary: startup.summary.slice(0, 300),
    location: startup.location || undefined,
    remote: startup.remote ?? undefined,
    stage: startup.stage || undefined,
    roles: startup.roles.length > 0 ? startup.roles : undefined,
    posted: startup.postedAt?.slice(0, 10),
    status: startup.status,
    match: startup.score,
    reasons: startup.reasons,
    addresses: emails.length > 0 ? emails.map(({ email, label, from }) => ({ email, label, published_on: from || undefined })) : undefined,
    people_addresses: emails.length < startup.emails.length ? startup.emails.length - emails.length : undefined,
    no_unsolicited_applications: startup.noApplicationsFrom || undefined,
    site_checked: startup.emailsCheckedAt?.slice(0, 10),
    notes: startup.notes || undefined,
    application_id: startup.applicationId ?? undefined,
    links: startup.links.length > 0 ? startup.links : undefined,
  };
}

/** The Startups screen showing one startup. */
const startupHref = (startup: StartupView) => startupFilterHref(startupFilterSchema.parse({ status: startup.status, q: startup.company.slice(0, 200) }));

/** Registers these tools on the connector's server. */
export function registerAgentTools({ server, linkTo }: ToolContext): void {
  /** One find with its posting's text and, once drafted, the draft's. */
  async function readFind(id: string) {
    const find = await prisma.agentCandidate.findUnique({ where: { id }, include: { application: { select: { documents: { select: { kind: true, units: true } } } } } });
    if (!find) return failure("That posting is no longer in the agent's queue.");
    const [drafting] = find.status === AgentCandidateStatus.DRAFTING || find.status === AgentCandidateStatus.SCORED ? await findUnfinishedJobs(draftJobKey(find.id)) : [];
    const documents = find.application?.documents ?? [];
    const doc = (kind: DocumentKind) => documentText(documents.find((document) => document.kind === kind)?.units) || undefined;
    const redFlags = stringsOf(find.redFlags);
    return text({
      find_id: find.id,
      status: FIND_STATUS[find.status],
      title: find.title.trim() || "Untitled posting",
      company: find.company || undefined,
      place: find.place || undefined,
      remote: find.remote ?? undefined,
      salary: find.salary || undefined,
      posted: find.postedAt?.toISOString().slice(0, 10),
      via: find.via || undefined,
      url: find.url || undefined,
      score: find.score,
      reasons: stringsOf(find.reasons),
      red_flags: redFlags.length > 0 ? redFlags : undefined,
      error: find.error ?? undefined,
      drafting_task_id: drafting?.id,
      posting: find.description.slice(0, 20_000) || undefined,
      only_a_snippet: find.description && !find.complete ? true : undefined,
      application_id: find.applicationId ?? undefined,
      resume: doc(DocumentKind.RESUME),
      cover_letter: doc(DocumentKind.COVER_LETTER),
      link: linkTo(find.applicationId ? `/applications/${find.applicationId}` : "/agent"),
    });
  }

  server.registerTool(
    "get_job_agent",
    {
      title: "Read the job agent",
      description:
        "The job agent's settings, recent runs, the drafts it prepared waiting for review, and the finds it scored, each with score, reasons and red flags. " +
        "Give find_id for one find with its posting and its draft's text. Act on finds with act_on_agent_find.",
      inputSchema: z.object({
        find_id: z.string().min(1).max(100).optional().describe("One find, with its posting and its draft's text"),
        include_below_minimum: z.boolean().optional().describe("Also list the finds scored below the minimum score"),
        include_dismissed: z.boolean().optional().describe("Also list the finds dismissed lately that restore can put back"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ find_id, include_below_minimum, include_dismissed }) => {
      if (find_id) return readFind(find_id);
      const now = new Date();
      const [view, settings, timeZone] = await Promise.all([loadAgentView(now), loadSettings(), lastKnownTimeZone()]);
      return text({
        settings: agentSettings(settings, timeZone),
        searches_for: view.search ?? undefined,
        setup_problem: view.setupProblem ?? undefined,
        daily_limit_reached: view.limitReached || undefined,
        next_run: view.nextRun ?? undefined,
        running_task_id: view.runJobId ?? undefined,
        recent_runs: settings.agentRuns.slice(0, 5).map((run) => ({ at: formatDateTime(new Date(run.at), timeZone, now), manual: run.manual || undefined, result: run.message ?? undefined })),
        drafts: view.drafts.map((find) => ({ ...findLine(find), application_id: find.applicationId, link: linkTo(`/applications/${find.applicationId}`) })),
        finds: view.scored.map(findLine),
        below_minimum_count: view.belowMinimum.length,
        below_minimum: include_below_minimum ? view.belowMinimum.map(findLine) : undefined,
        dismissed: include_dismissed ? await restorableFinds() : undefined,
        link: linkTo("/agent"),
      });
    },
  );

  server.registerTool(
    "update_job_agent",
    {
      title: "Change the job agent",
      description:
        "Changes the job agent's settings, as Settings → Job agent does: give only what changes. Turning it on needs keywords and a country. " +
        "run_now: true also runs it now, at most 3 times a day and an hour apart; follow it with check_task.",
      inputSchema: z.object({
        enabled: z.boolean().optional().describe("Whether it runs once a day"),
        keywords: z.string().trim().max(200).optional().describe("What it searches for, e.g. 'data scientist'"),
        place: z.string().trim().max(200).optional().describe("City or region; '' for the whole country"),
        country: z.string().trim().max(60).optional().describe("Country name or ISO code, e.g. 'Germany' or 'de'"),
        radius_km: z.literal(RADII_KM).optional(),
        remote_only: z.boolean().optional(),
        posted_within: z.enum(POSTED).optional().describe("any, day, 3days, week or month"),
        hour: z.number().int().min(0).max(23).optional().describe("The hour it runs after each day, in the user's time zone"),
        min_score: z.number().int().min(0).max(100).optional().describe("Finds scored lower stay out of the queue"),
        max_scores: z.number().int().min(1).max(30).optional().describe("The most postings a run scores"),
        auto_draft: z.boolean().optional().describe("Whether a run prepares drafts for its best finds on its own"),
        max_drafts: z.number().int().min(0).max(10).optional().describe("The most drafts a run prepares on its own"),
        run_now: z.boolean().optional().describe("Run it now, after saving any changes"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ run_now, enabled, keywords, place, country, radius_km, remote_only, posted_within, hour, min_score, max_scores, auto_draft, max_drafts }) => {
      let query: SearchQuery | undefined;
      if ([keywords, place, country, radius_km, remote_only, posted_within].some((value) => value !== undefined)) {
        const current = (await loadSettings()).agentQuery;
        const code = country === undefined ? current.country : countryCodeFor(country) || (/^[a-z]{2}$/i.test(country) ? country.toLowerCase() : "");
        if (country && !code) return failure("Dossier doesn't know that country. Give its name or ISO code, e.g. 'Germany' or 'de'.");
        query = {
          keywords: keywords ?? current.keywords,
          place: place ?? current.place,
          country: code,
          radiusKm: radius_km ?? current.radiusKm,
          remoteOnly: remote_only ?? current.remoteOnly,
          postedWithin: posted_within ?? current.postedWithin,
        };
      }
      const changes = { enabled, query, hour, minScore: min_score, maxScores: max_scores, maxDrafts: max_drafts, autoDraft: auto_draft };
      const changing = Object.values(changes).some((value) => value !== undefined);
      if (!changing && !run_now) return failure("Say what to change, or give run_now: true to run it now.");
      if (changing) {
        try {
          await updateAgentSettings(changes);
        } catch (error) {
          return refusal(error);
        }
      }
      if (run_now) {
        try {
          const run = await startAgentRun();
          return started(run.jobId, { saved: changing || undefined, already_running: run.reused || undefined, link: linkTo("/agent") });
        } catch (error) {
          if (changing && error instanceof ActionError) return failure(`Saved the changes, but it can't run now. ${error.message}`);
          return refusal(error);
        }
      }
      return text({ saved: true, settings: agentSettings(await loadSettings(), await lastKnownTimeZone()), link: linkTo("/agent") });
    },
  );

  server.registerTool(
    "act_on_agent_find",
    {
      title: "Act on a job agent find",
      description:
        "Acts on a find from get_job_agent: prepare_draft has Dossier write a tailored draft in the background (follow with check_task), approve moves a ready draft into Applications as a Draft, " +
        "dismiss drops the find and deletes its draft for good, and restore puts a dismissed find back. Nothing is sent; dismiss only when the user said so.",
      inputSchema: z.object({
        find_id: z.string().min(1).max(100),
        action: z.enum(["prepare_draft", "approve", "dismiss", "restore"]),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ find_id, action }) => {
      try {
        if (action === "prepare_draft") {
          const draft = await startCandidateDraft(find_id);
          if (draft.applicationId) {
            return text({ find_id, status: FIND_STATUS.DRAFTED, application_id: draft.applicationId, link: linkTo(`/applications/${draft.applicationId}`) });
          }
          return started(draft.jobId!, { find_id, already_running: !draft.started || undefined, link: linkTo("/agent") });
        }
        if (action === "approve") {
          const applicationId = await approveCandidate(find_id);
          return text({ find_id, application_id: applicationId, status: "Draft", message: "Added to Applications as a draft. Nothing has been sent.", link: linkTo(`/applications/${applicationId}`) });
        }
        if (action === "dismiss") {
          const { undo } = await dismissCandidate(find_id);
          return text({
            find_id,
            status: FIND_STATUS.DISMISSED,
            message: undo ? "Dismissed. It won't come back unless it's restored." : "Dismissed, with its draft if it had one. It won't come back.",
            link: linkTo("/agent"),
          });
        }
        await restoreDismissedCandidate(find_id);
        return text({ find_id, status: FIND_STATUS.SCORED, message: "It's back in the agent's queue.", link: linkTo("/agent") });
      } catch (error) {
        return refusal(error);
      }
    },
  );

  server.registerTool(
    "list_startups",
    {
      title: "List startups",
      description:
        "Startups that are hiring, from YC startups' job posts and Hacker News' Who is hiring?, as the Startups screen lists them: status, match score and reasons, notes and the addresses they publish. " +
        "Give id to read one with its post and people's own addresses. To write to one, save an application with its post as posting_text, then link it with update_startup's application_id.",
      inputSchema: z.object({
        id: z.string().min(1).max(64).optional().describe("One startup, with its post and people's own addresses"),
        status: z.enum(StartupStatus).optional().describe("NEW (To look at, the default), SAVED, CONTACTED or DISMISSED"),
        search: z.string().trim().max(200).optional().describe("Words to look for, e.g. 'android fintech'"),
        place: z.enum(STARTUP_PLACES).optional().describe("any, city or country (the profile's), or remote (open to its country)"),
        source: z.enum(STARTUP_SOURCES).optional().describe("YC or HN"),
        min_score: z.number().int().min(0).max(100).optional(),
        with_address: z.boolean().optional().describe("Only ones with an address to write to"),
        sort: z.enum(STARTUP_SORTS).optional().describe("match (the default) or newest"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, status, search, place, source, min_score, with_address, sort, limit }) => {
      if (id) {
        const startup = await getStartup(id);
        if (!startup) return failure(GONE);
        // Its post as "Write to them" hands it to New application, without addresses: an application keeps it, and Dossier's AI reads it.
        return text({ ...startupLine(startup, { people: true }), summary: startup.summary, post: startupPostingText(startup).slice(0, 20_000) || undefined, link: linkTo(startupHref(startup)) });
      }
      const filter = startupFilterSchema.parse({ q: search, place, source, minScore: min_score, withEmail: with_address, status, sort });
      const [profile, settings, timeZone, [running]] = await Promise.all([loadProfile(), loadSettings(), lastKnownTimeZone(), findUnfinishedJobs(STARTUPS_JOB_KEY)]);
      const list = await listStartups(filter, placeOf(profile.basics), { limit: limit ?? 20 });
      const last = settings.startupsLastRefresh;
      const problems = last?.sources.flatMap((entry) => (entry.error ? [entry.error] : [])) ?? [];
      return text({
        last_refresh: last ? formatDateTime(new Date(last.at), timeZone) : undefined,
        refresh_problems: problems.length > 0 ? problems : undefined,
        refreshing_task_id: running?.id,
        next: !last && !running ? "Nothing has been looked for yet. Call refresh_startups." : undefined,
        counts: list.counts,
        total: list.total,
        startups: list.startups.map((startup) => startupLine(startup)),
        link: linkTo(startupFilterHref(filter)),
      });
    },
  );

  server.registerTool(
    "refresh_startups",
    {
      title: "Refresh startups",
      description:
        "Looks for startups that are hiring and the addresses they publish for applications, as Refresh on the Startups screen does. " +
        "Takes a minute or two: follow it with check_task, then list_startups.",
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () => started(await startStartupsRefresh(), { link: linkTo("/startups") }),
  );

  server.registerTool(
    "update_startup",
    {
      title: "Update a startup",
      description:
        "Changes a startup's status or notes, links the application written to it, or looks on its own site for the addresses it publishes: look_up 'addresses' for application addresses, " +
        "'people' for people's own too, only when the user asks. Nothing is sent.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        status: z.enum(StartupStatus).optional().describe("SAVED, CONTACTED, DISMISSED, or NEW to move it back"),
        notes: z.string().max(5_000).optional().describe("Replaces the notes"),
        application_id: z.string().min(1).max(100).optional().describe("The application saved for it with save_application or draft_application; it counts as contacted once that's sent"),
        look_up: z.enum(["addresses", "people"]).optional().describe("Read the startup's own site for addresses"),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, status, notes, application_id, look_up }) => {
      if (!status && notes === undefined && !application_id && !look_up) return failure("Say what to change: status, notes, application_id or look_up.");
      let startup = await getStartup(id);
      if (!startup) return failure(GONE);
      if (look_up && !startup.website) return failure(`Dossier doesn't know ${startup.company}'s website, so it can't look there.`);
      if (look_up && startup.noApplicationsFrom) {
        return failure(`Their site says they don't take unsolicited applications: ${startup.noApplicationsFrom}. Apply through a posted job instead.`);
      }
      // Linked first: when it's refused, nothing has changed.
      if (application_id) {
        try {
          startup = await linkStartupApplication(id, application_id);
        } catch (error) {
          return refusal(error);
        }
        if (!startup) return failure(GONE);
      }
      if (status || notes !== undefined) {
        startup = await updateStartup(id, { status, notes });
        if (!startup) return failure(GONE);
      }
      let found: string | undefined;
      if (look_up) {
        const before = startup.emails.length;
        startup = await lookUpStartup(id, { people: look_up === "people" });
        if (!startup) return failure(GONE);
        const added = startup.emails.length - before;
        found = startup.noApplicationsFrom
          ? "Their site says they don't take unsolicited applications."
          : added > 0
            ? `Found ${added} ${added === 1 ? "address" : "addresses"} on their site.`
            : look_up === "people"
              ? "Their site doesn't publish anyone's own address."
              : "Their site doesn't publish an address for applications. Try their careers page.";
        if (look_up === "people" && !startup.applicationId && startup.emails.some((email) => email.onRequest)) {
          found += " People's own addresses are dropped after 14 days unless the user writes to this startup.";
        }
      }
      return text({
        ...startupLine(startup, { people: true }),
        found,
        message: application_id ? "Linked: Startups opens this application, and counts the startup as contacted once it's sent." : undefined,
        link: linkTo(startupHref(startup)),
      });
    },
  );

  server.registerTool(
    "remove_startup",
    {
      title: "Remove a startup for good",
      description:
        "Deletes what Dossier keeps about a startup, its addresses and notes, and refreshes leave it out from now on, as Remove for good does. " +
        "An application started from it stays. Only when the user said so.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const startup = await getStartup(id);
      if (!startup || !(await removeStartup(id))) return failure(GONE);
      return text({ removed: startup.company, message: "Removed. Refreshes won't bring it back.", link: linkTo("/startups") });
    },
  );
}
