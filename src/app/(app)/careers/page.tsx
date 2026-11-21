import type { Metadata } from "next";

import { listEmployers } from "@/lib/careers/store";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { openProfileId } from "@/lib/profiles";
import { userTimeZone } from "@/lib/time-zone";

import { CareersScreen } from "./careers-screen";

export const metadata: Metadata = { title: "Careers pages" };

/**
 * The employers whose own careers pages Dossier follows (jobauto fork):
 * checked once a day, with new jobs that match each one's words and places
 * added to Positions, before the job boards have them. A new employer's
 * words start from the search words of the profile last opened (E24-6).
 */
export default async function CareersPage() {
  const now = new Date();
  const [employers, profileId, recruiters, timeZone] = await Promise.all([listEmployers(), openProfileId(), prisma.recruiter.count(), userTimeZone()]);
  const profile = await loadProfile(profileId);
  return (
    <CareersScreen
      employers={employers}
      counts={{ recruiters, employers: employers.length }}
      suggestedWords={searchChips(searchWords(profile, now)).join(", ")}
      today={now.toISOString()}
      timeZone={timeZone ?? "UTC"}
    />
  );
}
