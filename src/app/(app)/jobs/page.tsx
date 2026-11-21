import type { Metadata } from "next";

import { listProfiles, openProfileId } from "@/lib/profiles";
import { isAiUsable } from "@/lib/ai/config";
import { profileGerman } from "@/lib/german-need";
import { loadHiddenTitles } from "@/lib/hidden-titles-data";
import { peopleAt } from "@/lib/network-data";
import { handsOffToClaude } from "@/lib/connector/handoff";
import { enabledPortals, jobSearchView, loadJobSearchConfig, portalSetup } from "@/lib/job-search/config";
import { portalsOffNote } from "@/lib/job-search/portals-off";
import { COUNTRIES } from "@/lib/job-search/countries";
import { isAddedSource } from "@/lib/job-search/sources";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { defaultSearch, EMPTY_QUERY, foundSearchIds, latestRole, libraryFromParams, queryFromParams, searchQuerySchema } from "@/lib/job-search/search";
import { countLibrary, listLibrary } from "@/lib/library";
import { listSearches, loadSearch } from "@/lib/posting-searches";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { loadScoringOff } from "@/lib/scoring-off-data";
import { userTimeZone } from "@/lib/time-zone";

import { JobsScreen } from "./jobs-screen";

export const metadata: Metadata = { title: "Positions" };

/**
 * Positions (E14-6, E22-5): the search form and the positions library,
 * through the filters in the URL (tab, show, found, portal, age, score);
 * ?tab=archive is the Archive (E22-7). A search
 * lands on ?found=<id>, what it found. Links from before still work:
 * ?search=<id> is "found by", ?view=saved and ?view=dismissed those kinds. A
 * search written in the URL (?q=…) only fills in the form.
 *
 * Kept from Find jobs (jobauto fork): search words from the profile last
 * opened, as chips in the form, and the titles employers use for its skills;
 * the German each posting asks for against the profile's; who she knows at
 * each employer; "Prepare it for me"; links to Recruiters and Careers pages,
 * which have screens of their own.
 */
export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const params = await searchParams;
  const filters = libraryFromParams(params);
  const typed = queryFromParams(params);
  const aiUsable = isAiUsable();
  const [config, timeZone, counts, scoreInClaude, canPrepare, settings, profiles, profileId, recruiters, employers] = await Promise.all([
    loadJobSearchConfig(),
    userTimeZone(),
    countLibrary(),
    aiUsable.then(handsOffToClaude),
    // Dossier's own AI model can write: postings offer "Prepare it for me" (jobauto fork).
    aiUsable,
    loadSettings(),
    listProfiles(),
    // The search words' profile: the one last opened, as New application picks it (E24-6).
    openProfileId(),
    prisma.recruiter.count(),
    prisma.employer.count(),
  ]);
  const now = new Date();
  // "Found by the agent" is all its searches at once, not one to show (E22-8).
  // An agent run's several searches (E26-4) have no one search to show above the list.
  const ids = foundSearchIds(filters.found);
  const oneSearch = ids?.length === 1 ? ids[0] : null;
  const [library, searches, foundSearch, profile, scoringOff, portalsOff] = await Promise.all([
    listLibrary(filters, { now }),
    listSearches({ timeZone, now }),
    oneSearch ? loadSearch(oneSearch, { timeZone, now }) : null,
    loadProfile(profileId),
    // Scoring waits while a profile has no levels (jobauto fork): a notice says so above the list.
    loadScoringOff(),
    // The one-time note about portals with a key that are off (jobauto fork).
    portalsOffNote(jobSearchView(config).portals),
  ]);
  const enabled = enabledPortals(config);
  const words = searchWords(profile, now);
  // What an AI client or a careers page added was no search of the user's: the form doesn't start from it.
  const searched = foundSearch && !isAddedSource(foundSearch.source) ? foundSearch.query : null;
  const [network, alsoAdvertised] = await Promise.all([
    // Who she knows at the employers on screen (jobauto fork); Show more brings the next pages' own.
    peopleAt(library.postings.map((posting) => posting.company)),
    // Titles of jobs seen that ask for the profile's skills but its searches miss (jobauto fork).
    loadHiddenTitles(profile, now),
  ]);

  return (
    <JobsScreen
      sources={enabled}
      scoringOff={scoringOff}
      portalsOff={portalsOff}
      arbeitsagenturNote={enabled.includes("ARBEITSAGENTUR") && !portalSetup(config, "ARBEITSAGENTUR")?.acceptedAt}
      scoreInClaude={scoreInClaude}
      profiles={profiles}
      // The profile's own search words, as one-click chips in the form, and all of them under "All search words"; named when there are several profiles.
      suggestions={searchChips(words)}
      wordGroups={words.groups.map((group) => ({ title: group.title, words: group.words.map(({ text, why }) => ({ text, why })) }))}
      suggestionsFrom={profiles.length > 1 ? (profiles.find((entry) => entry.id === profileId)?.name ?? null) : null}
      alsoAdvertised={alsoAdvertised}
      // German is shared by every profile: each posting's is read against it.
      german={profileGerman(profile.languages)}
      network={network}
      canPrepare={canPrepare}
      // Named here: the browser's ICU can name a few countries differently from the server's.
      countries={COUNTRIES}
      query={typed ?? searched ?? (await latestQuery()) ?? (await profileSearch())}
      // A search in the URL opens the form to run it (E32-3); ?edit=1 opens it as it is, as Profile's link to the search words does (jobauto fork).
      editing={typed !== null || params.edit === "1"}
      filters={filters}
      library={library}
      searches={searches}
      foundSearch={foundSearch}
      missingSearch={Boolean(oneSearch) && !foundSearch}
      counts={counts}
      archiveDays={settings.archiveAfterDays}
      elsewhere={{ recruiters, employers }}
      today={now.toISOString()}
    />
  );
}

/** What was searched last, for the form when no search is open: not what an AI client or a careers page added (jobauto fork). */
async function latestQuery() {
  const latest = await prisma.postingSearch.findFirst({ where: { agentSearchName: null, addedBy: "" }, orderBy: { createdAt: "desc" }, select: { query: true } });
  return latest ? searchQuerySchema.catch(EMPTY_QUERY).parse(latest.query) : null;
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
