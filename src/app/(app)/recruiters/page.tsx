import type { Metadata } from "next";

import { loadProfile } from "@/lib/profile-data";
import { openProfileId } from "@/lib/profiles";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import { networkSummary } from "@/lib/network-data";
import { outreachFacts } from "@/lib/recruiters/facts";
import { listRecruiters } from "@/lib/recruiters/store";

import { RecruitersScreen } from "./recruiters-screen";

export const metadata: Metadata = { title: "Recruiters" };

/**
 * The recruiters and agencies the user keeps track of: where each
 * conversation stands, when a follow-up is due, and a message to write next,
 * from the profile last opened (as New application picks it, E24-6), with
 * that profile's Base resume. Nothing is sent: the user sends it from their
 * own mail.
 */
export default async function RecruitersPage() {
  const [recruiters, profileId, employers, settings, network] = await Promise.all([listRecruiters(), openProfileId(), prisma.employer.count(), loadSettings(), networkSummary()]);
  const profile = await loadProfile(profileId);
  return (
    <RecruitersScreen
      recruiters={recruiters}
      counts={{ recruiters: recruiters.length, employers }}
      // With the standard answers, an agency's first message carries a brief (jobauto fork).
      facts={outreachFacts(profile, settings.applyAnswers)}
      profileId={profileId}
      network={network}
      today={new Date().toISOString()}
    />
  );
}
