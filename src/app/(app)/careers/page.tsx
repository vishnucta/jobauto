import type { Metadata } from "next";

import { listEmployers } from "@/lib/careers/store";
import { peopleAt } from "@/lib/network-data";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { countSearches } from "@/lib/posting-searches";
import { countPostings } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { userTimeZone } from "@/lib/time-zone";

import { CareersScreen } from "./careers-screen";

export const metadata: Metadata = { title: "Careers pages" };

/**
 * The employers whose own careers pages Find jobs follows (jobauto fork):
 * checked once a day, with new jobs that match each one's words and places
 * added to Find jobs, before the job boards have them.
 */
export default async function CareersPage() {
  const now = new Date();
  const [employers, profile, postingCounts, searches, recruiters, timeZone] = await Promise.all([listEmployers(), loadProfile(), countPostings(), countSearches(), prisma.recruiter.count(), userTimeZone()]);
  return (
    <CareersScreen
      employers={employers}
      counts={{ ...postingCounts, searches, recruiters, employers: employers.length }}
      suggestedWords={searchChips(searchWords(profile, now)).join(", ")}
      today={now.toISOString()}
      timeZone={timeZone ?? "UTC"}
      network={await peopleAt(employers.map((employer) => employer.name))}
    />
  );
}
