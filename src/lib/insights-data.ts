import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { germanFit, profileGerman } from "@/lib/german-need";
import { insights, type Insights } from "@/lib/insights";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { prisma } from "@/lib/prisma";
import { agencyOf } from "@/lib/recruiters/types";
import { loadSettings } from "@/lib/settings-data";
import { weeklyProgress, type WeeklyProgress } from "@/lib/weekly-target";

// The dashboard's weekly target and What's working (jobauto fork), from the
// applications sent, archived ones included.

/** Every sent application's send time, for the weekly target. */
export async function loadWeeklyProgress(timeZone: string, now = new Date()): Promise<WeeklyProgress> {
  const [{ weeklyTarget }, sent] = await Promise.all([
    loadSettings(),
    prisma.application.findMany({ where: { sentAt: { not: null }, awaitingReview: false }, select: { sentAt: true } }),
  ]);
  return weeklyProgress(
    sent.map((application) => application.sentAt!),
    weeklyTarget,
    now,
    timeZone,
  );
}

/** What's working, from every sent application. */
export async function loadInsights(): Promise<Insights> {
  const [applications, languages] = await Promise.all([
    prisma.application.findMany({
      where: { sentAt: { not: null }, awaitingReview: false },
      select: {
        status: true,
        furthestStage: true,
        origin: true,
        company: true,
        language: true,
        postingText: true,
        posting: { select: { source: true } },
        startup: { select: { id: true } },
        documents: { where: { kind: DocumentKind.RESUME }, select: { theme: { select: { name: true } } } },
      },
    }),
    prisma.language.findMany({ select: { name: true, level: true } }),
  ]);
  const german = profileGerman(languages);
  return insights(
    applications.map((application) => ({
      status: application.status,
      furthestStage: application.furthestStage,
      foundVia:
        application.origin === "AGENT"
          ? "Job agent"
          : application.posting
            ? SOURCE_INFO[application.posting.source].name
            : application.startup
              ? "Startups"
              : "Pasted or by hand",
      agency: agencyOf(application.company) !== null,
      language: application.language,
      theme: application.documents[0]?.theme?.name ?? "",
      german: application.postingText.trim() ? germanFit(application.postingText, german).verdict : null,
    })),
  );
}
