import "server-only";

import { cache } from "react";

import { dayOf, startOfDay } from "@/lib/calendar-view";
import { checkStillOpen, fieldMatch, lowFit } from "@/lib/field-match";
import { germanFit, profileGerman, textForGerman, type ProfileGerman } from "@/lib/german-need";
import { REPORTING_PROFILE } from "@/lib/hidden-titles";
import { postingKey, type ShownPosting } from "@/lib/job-search/search";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { withStates } from "@/lib/library";
import { prepareJobKey } from "@/lib/posting-application";
import { coverageOf, type Coverage } from "@/lib/posting-coverage";
import { foundFromPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import type { ProfileData } from "@/lib/profile";
import { loadProfile } from "@/lib/profile-data";
import { listProfiles } from "@/lib/profiles";
import { weekStart } from "@/lib/weekly-target";

// In your field (field-match.ts, jobauto fork), read from the database: which
// of her profiles is in the field, this week's marked postings for the
// dashboard's line, and the marked postings Today's three may take. Only
// postings already in Positions are read: nothing here asks a job portal.

/** What every list leaves out: one merged into another, and one removed from the Archive. */
const KEPT = { mergedIntoId: null, removedAt: null } as const;

/** How many of the newest open postings are read for Today's three; the library itself reads every one. */
const WEIGHED = 500;

/** A profile's words that say what field it's in, as Careers pages reads them. */
const fieldText = (profile: ProfileData) =>
  [profile.basics.headline, profile.basics.summary, ...profile.experience.flatMap((role) => [role.role, role.bullets]), ...profile.skills.map((skill) => skill.name)].join(" ");

/**
 * Her profiles that are in the field (hidden-titles.ts REPORTING_PROFILE), in
 * their order. The mark shows while there is one. Read once for a page: the
 * dashboard asks for its line and for Today's three.
 */
export const fieldProfiles = cache(async (): Promise<{ id: string; name: string }[]> => {
  const profiles = await listProfiles();
  const inField = await Promise.all(profiles.map(async (profile) => REPORTING_PROFILE.test(fieldText(await loadProfile(profile.id)))));
  return profiles.filter((_, index) => inField[index]).map(({ id, name }) => ({ id, name }));
});

/** Whether any of her profiles is in the field. */
export const hasFieldProfile = async (): Promise<boolean> => (await fieldProfiles()).length > 0;

/** Her German, which every profile shares. */
export async function herGerman(): Promise<ProfileGerman> {
  return profileGerman(await prisma.language.findMany({ select: { name: true, level: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] }));
}

/**
 * This week's marked postings (Monday to Sunday in her time zone, as the
 * weekly target counts): how many Positions first kept this week, and how
 * many of those she applied to, a Draft not counting. Null while no profile
 * is in the field.
 */
export async function loadFieldWeek(timeZone: string, now = new Date()): Promise<{ found: number; applied: number } | null> {
  if (!(await hasFieldProfile())) return null;
  const since = startOfDay(weekStart(dayOf(now, timeZone)), timeZone);
  const rows = await prisma.posting.findMany({ where: { ...KEPT, createdAt: { gte: since } } });
  const marked = await withStates(rows.map(foundFromPosting).filter((posting) => fieldMatch(posting) !== null));
  return { found: marked.length, applied: marked.filter((posting) => posting.state.applicationId !== null && !posting.state.draft).length };
}

/** A marked posting Today's three may take (today.ts). */
export type FieldPick = {
  postingId: string;
  /** The job agent's find of it, when the agent scored it too: shown once, here. */
  candidateId: string | null;
  title: string;
  company: string;
  url: string;
  coverage: Coverage;
  /** Posted more than 30 days ago, or with no date. */
  stale: boolean;
  /** When the ad was posted, else when Positions first kept it: the newest first. */
  at: number;
  /** Its application being written already. */
  jobId: string | null;
};

/** Whether Today's three may take a marked posting: open, not applied for, not a low fit, and within reach of her German or unknown. */
function qualifies(posting: ShownPosting, german: ProfileGerman): boolean {
  const { state } = posting;
  if (state.applicationId !== null || state.dismissed || state.archived) return false;
  // The agent's draft of it is on the list already; one she dismissed there stays off.
  if (state.agent && state.agent.status !== "SCORED") return false;
  if (lowFit(coverageOf(state.score))) return false;
  return germanFit(textForGerman(posting), german).verdict !== "out";
}

/**
 * The marked postings Today's three may take, the newest ad first: open in
 * Positions, with no application, never a scored low fit, and none that
 * needs far more German than she has. Empty while no profile is in the field.
 */
export async function loadFieldPicks(count: number, now = new Date()): Promise<FieldPick[]> {
  if (count <= 0 || !(await hasFieldProfile())) return [];
  const rows = await prisma.posting.findMany({
    where: { ...KEPT, archivedAt: null, dismissedAt: null, applicationId: null },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: WEIGHED,
  });
  const foundAt = new Map(rows.map((row) => [postingKey(row), row.createdAt.getTime()]));
  const [marked, german] = await Promise.all([withStates(rows.map(foundFromPosting).filter((posting) => fieldMatch(posting) !== null)), herGerman()]);
  const picks = marked
    .filter((posting) => posting.state.postingId !== null && qualifies(posting, german))
    .map((posting) => ({ posting, at: posting.postedAt ? new Date(posting.postedAt).getTime() : (foundAt.get(postingKey(posting)) ?? 0) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, count);
  return Promise.all(
    picks.map(async ({ posting, at }) => ({
      postingId: posting.state.postingId!,
      candidateId: posting.state.agent?.candidateId ?? null,
      title: posting.title.trim() || "Untitled posting",
      company: posting.company.trim(),
      url: posting.url,
      coverage: coverageOf(posting.state.score),
      stale: checkStillOpen(posting.postedAt, now),
      at,
      jobId: (await findUnfinishedJobs(prepareJobKey(posting.state.postingId!)))[0]?.id ?? null,
    })),
  );
}
