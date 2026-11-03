import type { Metadata } from "next";

import { languageLevelLabel } from "@/lib/profile";
import { loadProfile } from "@/lib/profile-data";
import { countPostings } from "@/lib/postings";
import { countSearches } from "@/lib/posting-searches";
import { listRecruiters } from "@/lib/recruiters/store";

import { RecruitersScreen } from "./recruiters-screen";

export const metadata: Metadata = { title: "Recruiters" };

/**
 * The recruiters and agencies the user keeps track of: where each
 * conversation stands, when a follow-up is due, and a message to write next,
 * from the profile. Nothing is sent: the user sends it from their own mail.
 */
export default async function RecruitersPage() {
  const [recruiters, profile, postingCounts, searches] = await Promise.all([listRecruiters(), loadProfile(), countPostings(), countSearches()]);
  return (
    <RecruitersScreen
      recruiters={recruiters}
      counts={{ ...postingCounts, searches, recruiters: recruiters.length }}
      facts={{
        name: profile.basics.name.trim(),
        headline: profile.basics.headline.trim(),
        city: profile.basics.city.trim(),
        languages: profile.languages.map((language) => ({ name: language.name, level: languageLevelLabel(language.level) })),
      }}
      today={new Date().toISOString()}
    />
  );
}
