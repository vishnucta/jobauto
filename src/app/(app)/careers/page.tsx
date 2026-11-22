import type { Metadata } from "next";

import { FIELD_EMPLOYERS } from "@/lib/careers/field-employers";
import { listEmployers } from "@/lib/careers/store";
import { REPORTING_PROFILE } from "@/lib/hidden-titles";
import { peopleAt } from "@/lib/network-data";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { prisma } from "@/lib/prisma";
import type { ProfileData } from "@/lib/profile";
import { loadProfile } from "@/lib/profile-data";
import { listProfiles, openProfileId } from "@/lib/profiles";
import { userTimeZone } from "@/lib/time-zone";

import { CareersScreen } from "./careers-screen";

export const metadata: Metadata = { title: "Careers pages" };

/** A profile's words that say what field it's in. */
const fieldText = (profile: ProfileData) =>
  [profile.basics.headline, profile.basics.summary, ...profile.experience.flatMap((role) => [role.role, role.bullets]), ...profile.skills.map((skill) => skill.name)].join(" ");

/**
 * The employers whose own careers pages Dossier follows (jobauto fork):
 * checked once a day, with new jobs that match each one's words and places
 * added to Positions, before the job boards have them. A new employer's
 * words start from the search words of the profile last opened (E24-6).
 */
export default async function CareersPage() {
  const now = new Date();
  const [employers, profileId, summaries, recruiters, timeZone] = await Promise.all([listEmployers(), openProfileId(), listProfiles(), prisma.recruiter.count(), userTimeZone()]);
  const profile = await loadProfile(profileId);
  // Employers in her field, while any of her profiles is in it (field-employers.ts): a new, empty one opened last mustn't hide them.
  const profiles = await Promise.all(summaries.map((summary) => (summary.id === profileId ? profile : loadProfile(summary.id))));
  const field = profiles.some((each) => REPORTING_PROFILE.test(fieldText(each))) ? FIELD_EMPLOYERS : [];
  return (
    <CareersScreen
      employers={employers}
      counts={{ recruiters, employers: employers.length }}
      suggestedWords={searchChips(searchWords(profile, now)).join(", ")}
      today={now.toISOString()}
      timeZone={timeZone ?? "UTC"}
      network={await peopleAt([...employers.map((employer) => employer.name), ...field.map((employer) => employer.name)])}
      fieldEmployers={field}
    />
  );
}
