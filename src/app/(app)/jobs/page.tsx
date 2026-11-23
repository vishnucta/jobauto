import type { Metadata } from "next";

import { listProfiles, openProfileId, profileSearchDefaults, type ProfileSummary } from "@/lib/profiles";
import { isAiUsable } from "@/lib/ai/config";
import { hasFieldProfile } from "@/lib/field-data";
import { profileGerman } from "@/lib/german-need";
import { loadHiddenTitles } from "@/lib/hidden-titles-data";
import { peopleAt } from "@/lib/network-data";
import { handsOffToClaude } from "@/lib/connector/handoff";
import { enabledPortals, jobSearchView, loadJobSearchConfig, portalSetup } from "@/lib/job-search/config";
import { portalsOffNote } from "@/lib/job-search/portals-off";
import { COUNTRIES } from "@/lib/job-search/countries";
import { isAddedSource } from "@/lib/job-search/sources";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { defaultSearch, foundSearchIds, latestRole, libraryFromParams, queryFromParams, type SearchQuery } from "@/lib/job-search/search";
import { countLibrary, listLibrary } from "@/lib/library";
import { listSearches, loadSearch } from "@/lib/posting-searches";
import { prisma } from "@/lib/prisma";
import type { ProfileData } from "@/lib/profile";
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
 * opened (or the first with any, while that one is still empty), as chips
 * in the form, a new search starting from the first of them, and the titles employers use for its skills;
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
  const [library, searches, foundSearch, opened, scoringOff, portalsOff, inField] = await Promise.all([
    listLibrary(filters, { now }),
    listSearches({ timeZone, now }),
    oneSearch ? loadSearch(oneSearch, { timeZone, now }) : null,
    loadProfile(profileId),
    // Scoring waits while a profile has no levels (jobauto fork): a notice says so above the list.
    loadScoringOff(),
    // The one-time note about portals with a key that are off (jobauto fork).
    portalsOffNote(jobSearchView(config).portals),
    // Postings in her own field are marked while any of her profiles is in it (jobauto fork, field-match.ts).
    hasFieldProfile(),
  ]);
  const enabled = enabledPortals(config);
  const { id: wordsFrom, profile, words } = await profileWithWords(opened, profileId, profiles, now);
  const chips = searchChips(words);
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
      inField={inField}
      arbeitsagenturNote={enabled.includes("ARBEITSAGENTUR") && !portalSetup(config, "ARBEITSAGENTUR")?.acceptedAt}
      scoreInClaude={scoreInClaude}
      profiles={profiles}
      // The profile's own search words, as one-click chips in the form, and all of them under "All search words"; named when there are several profiles.
      suggestions={chips}
      wordGroups={words.groups.map((group) => ({ title: group.title, words: group.words.map(({ text, why }) => ({ text, why })) }))}
      suggestionsFrom={profiles.length > 1 ? (profiles.find((entry) => entry.id === wordsFrom)?.name ?? null) : null}
      alsoAdvertised={alsoAdvertised}
      // German is shared by every profile: each posting's is read against it.
      german={profileGerman(profile.languages)}
      network={network}
      canPrepare={canPrepare}
      // Named here: the browser's ICU can name a few countries differently from the server's.
      countries={COUNTRIES}
      query={typed ?? searched ?? (await profileSearch(wordsFrom, chips[0] ?? latestRole(profile.experience)))}
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

/**
 * The profile the search words come from: the one last opened, or, while it
 * has none (a new, empty profile), the first that has (jobauto fork).
 */
async function profileWithWords(opened: ProfileData, openedId: string, profiles: readonly ProfileSummary[], now: Date) {
  const words = searchWords(opened, now);
  if (searchChips(words).length > 0) return { id: openedId, profile: opened, words };
  for (const { id } of profiles.filter((entry) => entry.id !== openedId)) {
    const profile = await loadProfile(id);
    const theirs = searchWords(profile, now);
    if (searchChips(theirs).length > 0) return { id, profile, words: theirs };
  }
  return { id: openedId, profile: opened, words };
}

/**
 * A new search, when none is open: the profile's first search word (else its
 * latest role), with its levels, place and radius. Not the last search typed
 * (jobauto fork): that may have been one employer's, from Careers pages.
 */
async function profileSearch(profileId: string, words: string): Promise<SearchQuery> {
  return { ...defaultSearch({ role: words, city: "", country: "" }), ...(await profileSearchDefaults(profileId)) };
}
