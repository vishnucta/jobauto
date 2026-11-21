import type { Metadata } from "next";

import { loadProfile } from "@/lib/profile-data";
import { openProfileId } from "@/lib/profiles";
import { prisma } from "@/lib/prisma";
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
  const [recruiters, profileId, employers] = await Promise.all([listRecruiters(), openProfileId(), prisma.employer.count()]);
  const profile = await loadProfile(profileId);
  return (
    <RecruitersScreen
      recruiters={recruiters}
      counts={{ recruiters: recruiters.length, employers }}
      facts={outreachFacts(profile)}
      profileId={profileId}
      today={new Date().toISOString()}
    />
  );
}
