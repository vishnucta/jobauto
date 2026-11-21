import "server-only";

import { z } from "zod";

import { defineJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { emit } from "@/lib/notifications/notify";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { SourceError } from "./http";
import { placeOf } from "./place";
import { fetchHnStartups } from "./sources/hn";
import { fetchLicensedFirms } from "./sources/licences";
import { fetchYcStartups } from "./sources/yc";
import { lookUpStartup, rescoreStartups, sweepStartups, upsertStartups } from "./store";
import { sourcesOn, STARTUP_SOURCE_INFO, startupsRefreshSchema, type FoundStartup, type StartupSource, type StartupsRefresh } from "./types";

// "Refresh" on the Startups screen (#222), and once a day while the screen
// is in use: asks every source switched on what's new (YC, Hacker News, and
// ESMA's registers for firms newly licensed in Germany; in this fork only
// ESMA's until she switches the others on), keeps it, scores it, and looks
// for role addresses on the best new matches' own sites. One source failing
// doesn't stop the other; what happened is kept for the screen. A source
// switched off isn't asked, and what it found before stays.

export const STARTUPS_JOB_KEY = "startups-refresh";
/** Sites read for addresses per refresh: the best matches not checked yet. */
const SITE_LOOKUPS = 12;
/** Different sites read at once; each site's own pages are read one at a time. */
const SITE_CONCURRENCY = 4;

/** Runs the sources switched on, keeps what they found, and looks up addresses for the best new startups. */
export async function refreshStartups(
  step: (name: string) => Promise<void> = async () => {},
  signal: AbortSignal = new AbortController().signal,
  now = new Date(),
): Promise<StartupsRefresh> {
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  const place = placeOf(profile.basics);
  const fetchers: Record<StartupSource, () => Promise<FoundStartup[]>> = {
    YC: () => fetchYcStartups(signal),
    HN: () => fetchHnStartups(place, signal),
    LICENCE: () => fetchLicensedFirms(signal, now),
  };
  const asked = sourcesOn(settings.startupSources);
  const sources = asked.map((source) => ({ source, fetch: fetchers[source] }));

  await step(asked.length > 0 ? `Asking ${sourceNames(asked)}` : "No source is switched on");
  const results = await Promise.allSettled(sources.map((entry) => entry.fetch()));
  signal.throwIfAborted();
  const outcomes = results.map((result, index) => {
    const { source } = sources[index];
    if (result.status === "fulfilled") return { source, found: result.value.length, error: null };
    const reason = result.reason instanceof SourceError ? result.reason.message : "failed";
    if (!(result.reason instanceof SourceError)) logServerError(`startups: ${source}`, result.reason);
    return { source, found: 0, error: `${STARTUP_SOURCE_INFO[source].name} ${reason}` };
  });
  const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  await step(`Scoring ${found.length} ${found.length === 1 ? "startup" : "startups"} against your profile`);
  const licensed = found.filter((startup) => startup.source === "LICENCE").map((startup) => startup.externalId);
  const knownLicensed = new Set(
    (await prisma.startup.findMany({ where: { source: "LICENCE", externalId: { in: licensed } }, select: { externalId: true } })).map((row) => row.externalId),
  );
  // The first time, every firm of the past year is new: the screen shows them, without an alert.
  const firstLook = (await prisma.startup.count({ where: { source: "LICENCE" } })) === 0;
  const added = await upsertStartups(found, now);
  // Newly licensed firms are rare and early is the point: they're a
  // notification ("Newly licensed firms" in Settings → Notifications).
  const newFirms = await prisma.startup.findMany({
    where: { source: "LICENCE", externalId: { in: licensed.filter((id) => !knownLicensed.has(id)) } },
    orderBy: { score: "desc" },
    select: { company: true, location: true },
  });
  if (newFirms.length > 0 && !firstLook) {
    await emit("startups.licensed", { firms: newFirms.map((firm) => ({ company: firm.company, place: firm.location.replace(/, Germany$/, "") })) }, now);
  }
  // Ones this refresh didn't find again are scored against today's profile too.
  await rescoreStartups(now);
  await sweepStartups(now, asked);

  await step("Looking for application addresses on their own sites");
  const toCheck = await prisma.startup.findMany({
    where: { status: { in: ["NEW", "SAVED"] }, emailsCheckedAt: null, website: { not: "" }, noApplicationsFrom: "" },
    orderBy: { score: "desc" },
    take: SITE_LOOKUPS,
    select: { id: true, emails: true },
  });
  let emailsFound = 0;
  for (let index = 0; index < toCheck.length; index += SITE_CONCURRENCY) {
    signal.throwIfAborted();
    const batch = toCheck.slice(index, index + SITE_CONCURRENCY);
    const checked = await Promise.allSettled(batch.map((startup) => lookUpStartup(startup.id, { now })));
    checked.forEach((result, position) => {
      const before = Array.isArray(batch[position].emails) ? (batch[position].emails as unknown[]).length : 0;
      if (result.status === "fulfilled" && result.value && result.value.emails.length > before) emailsFound += 1;
      if (result.status === "rejected") logServerError("startups: address lookup", result.reason);
    });
  }

  const result: StartupsRefresh = { at: now.toISOString(), added, sources: outcomes, emailsFound };
  await saveSettings({ startupsLastRefresh: result });
  return result;
}

/** "Y Combinator, Hacker News and ESMA registers", or fewer. */
function sourceNames(sources: readonly StartupSource[]): string {
  const names = sources.map((source) => STARTUP_SOURCE_INFO[source].name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
}

export const refreshStartupsJob = defineJob({
  type: "startups-refresh",
  input: z.object({}),
  result: startupsRefreshSchema,
  run: (_input, { step, signal }) => refreshStartups(step, signal),
});

/** Starts a refresh unless one is under way; returns its job. */
export async function startStartupsRefresh(): Promise<string> {
  const [running] = await findUnfinishedJobs(STARTUPS_JOB_KEY);
  return running?.id ?? startJob(refreshStartupsJob, {}, { key: STARTUPS_JOB_KEY });
}
