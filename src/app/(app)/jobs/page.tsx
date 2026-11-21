import type { Metadata } from "next";

import { isAiUsable } from "@/lib/ai/config";
import { profileGerman } from "@/lib/german-need";
import { loadHiddenTitles } from "@/lib/hidden-titles-data";
import { peopleAt } from "@/lib/network-data";
import { handsOffToClaude } from "@/lib/connector/handoff";
import { loadJobSearchConfig } from "@/lib/job-search/config";
import { COUNTRIES } from "@/lib/job-search/countries";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { loadProfile } from "@/lib/profile-data";
import { sourceStates } from "@/lib/job-search/find";
import { byScoreFromParams, defaultSearch, latestRole, queryFromParams, sourceFilterFromParams, viewFromParams } from "@/lib/job-search/search";
import { countSearches, foundPostings, listSearches, loadSearch } from "@/lib/posting-searches";
import { countPostings, listPostings } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { userTimeZone } from "@/lib/time-zone";

import { JobsScreen } from "./jobs-screen";

export const metadata: Metadata = { title: "Find jobs" };

/**
 * Find jobs (E14-6). Every search is kept with what it found (E14-10):
 * ?search=<id> opens one, and without it the latest one shows, so going back
 * costs no searches. ?view=history lists past searches; ?view=saved and
 * ?view=dismissed the postings kept from them (E14-7); ?view=history&sort=score
 * every posting past searches found, highest score first; ?from=client narrows
 * those views to one source, keeping what AI clients found apart. A search
 * written in the URL (?q=…) only fills in the form.
 */
export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const params = await searchParams;
  const view = viewFromParams(params);
  const from = sourceFilterFromParams(params);
  const typed = queryFromParams(params);
  const searchId = typeof params.search === "string" ? params.search : undefined;
  const aiUsable = isAiUsable();
  const [config, timeZone, postingCounts, searches, recruiters, employers, profile, scoreInClaude, canPrepare] = await Promise.all([
    loadJobSearchConfig(),
    userTimeZone(),
    countPostings(),
    countSearches(),
    prisma.recruiter.count(),
    prisma.employer.count(),
    loadProfile(),
    aiUsable.then(handsOffToClaude),
    aiUsable,
  ]);
  const now = new Date();

  const search = view === "search" && !typed ? await loadSearch(searchId, { timeZone, now }) : null;
  const byScore = view === "history" && byScoreFromParams(params);
  const [kept, history, found] = await Promise.all([
    view === "saved" || view === "dismissed" ? listPostings(view) : undefined,
    view === "history" && !byScore ? listSearches({ timeZone, now }) : undefined,
    byScore ? foundPostings() : undefined,
  ]);
  // Who she knows at the employers on screen (jobauto fork).
  const network = await peopleAt([...(search?.postings ?? []), ...(kept ?? []), ...(found ?? [])].map((posting) => posting.company));

  return (
    <JobsScreen
      source={config.source}
      // The profile's own search words, as one-click chips above the form.
      suggestions={searchChips(searchWords(profile, now))}
      alsoAdvertised={await loadHiddenTitles(profile, now)}
      sources={sourceStates(config)}
      arbeitsagenturNote={config.source === "ARBEITSAGENTUR" && !config.arbeitsagentur.acceptedAt}
      scoreInClaude={scoreInClaude}
      german={profileGerman(profile.languages)}
      network={network}
      canPrepare={canPrepare}
      // Named here: the browser's ICU can name a few countries differently from the server's.
      countries={COUNTRIES}
      view={view}
      from={from}
      query={typed ?? search?.query ?? (await latestQuery()) ?? (await profileSearch())}
      search={search}
      missingSearch={Boolean(searchId) && !search}
      kept={kept}
      history={history}
      byScore={byScore}
      found={found}
      counts={{ ...postingCounts, searches, recruiters, employers }}
      today={now.toISOString()}
    />
  );
}

/** What was searched last, for the form when no search is open. */
async function latestQuery() {
  return (await loadSearch())?.query ?? null;
}

/** The first search: the current or latest role, in the profile's city and country. */
async function profileSearch() {
  const [fields, experience] = await Promise.all([
    prisma.profileField.findMany({ where: { key: { in: ["city", "country"] } } }),
    prisma.experience.findMany({ select: { role: true, current: true, startYear: true, startMonth: true, endYear: true, endMonth: true } }),
  ]);
  const field = (key: string) => fields.find((entry) => entry.key === key)?.value ?? "";
  return defaultSearch({ role: latestRole(experience), city: field("city"), country: field("country") });
}
