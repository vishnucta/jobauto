import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { applyJobKey } from "@/lib/jobs/apply";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import { describeGuide } from "@/lib/salary-guide";
import { loadSalaryGuide } from "@/lib/salary-guide-data";
import type { Basics } from "@/lib/profile";
import type { SettingsData } from "@/lib/settings";

import { hostOf } from "./ats";
import { findPostingAt } from "./link-owner";
import { planFor } from "./plan";
import { isWatching } from "./watches";
import { filledSchema, unfilledSchema } from "./run-types";
import type { ApplyAttemptView, ApplyPlanView, ApplyTabData } from "./view";

const ATTEMPTS_SHOWN = 8;

/** The basics forms nearly always ask for. */
const ASKED: readonly [keyof Basics, string][] = [
  ["phone", "phone number"],
  ["street", "street"],
  ["postalCode", "postal code"],
  ["city", "city"],
];

/** "30 Oct, 14:32" in the user's time zone. */
function when(date: Date, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  }
}

/** Everything the Apply tab shows for an application. */
export async function loadApplyTab(
  application: { id: string; postingUrl: string; postingText: string; documents: { kind: DocumentKind }[]; role?: string; title?: string; company?: string },
  profile: { basics: Basics },
  settings: Pick<SettingsData, "applyAnswers" | "applyBrowserAddress">,
  timeZone: string | undefined,
): Promise<ApplyTabData> {
  const [posting, rows, jobs, guide] = await Promise.all([
    prisma.posting.findUnique({ where: { applicationId: application.id }, select: { url: true, source: true } }),
    prisma.applyAttempt.findMany({ where: { applicationId: application.id }, orderBy: { startedAt: "desc" }, take: ATTEMPTS_SHOWN }),
    findUnfinishedJobs(applyJobKey(application.id)),
    loadSalaryGuide(application.role || application.title || ""),
  ]);
  const company = application.company ?? "";
  const route = planFor({ postingUrl: application.postingUrl, postingText: application.postingText, posting, company });
  const plan: ApplyPlanView =
    route.kind === "web"
      ? {
          kind: "web",
          url: route.url,
          host: route.host,
          atsLabel: route.ats.label,
          account: route.ats.account,
          autoSubmitOk: route.ats.autoSubmit,
          board: route.ats.board,
          owner: route.owner,
        }
      : route;
  // A copy of the ad, or a site that may be one (link-owner.ts): the way to the employer's own posting, a careers page she follows first.
  const doubtful = route.kind === "web" && (route.owner?.kind === "copy" || route.owner?.kind === "unsure");
  const followed = doubtful ? await prisma.employer.findMany({ select: { name: true, careersUrl: true }, orderBy: { createdAt: "asc" } }) : [];
  const role = application.role || (application.title ?? "").split(" · ")[0] || "";
  const attempts: ApplyAttemptView[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    note: row.note,
    startedAt: when(row.startedAt, timeZone),
    host: hostOf(row.url),
    filled: filledSchema.safeParse(row.filled).data ?? [],
    unfilled: unfilledSchema.safeParse(row.unfilled).data ?? [],
    captcha: row.captcha,
    screenshot: row.screenshot,
    confirmation: row.confirmation,
    autoSubmit: row.autoSubmit,
    watching: isWatching(row.id),
  }));
  return {
    plan,
    answers: settings.applyAnswers,
    attempts,
    running: jobs.at(-1)?.id ?? null,
    runningKind: jobs.length === 0 ? null : jobs.at(-1)?.type === "apply-page" ? "page" : "run",
    hasResume: application.documents.some((document) => document.kind === DocumentKind.RESUME),
    hasLetter: application.documents.some((document) => document.kind === DocumentKind.COVER_LETTER),
    missing: ASKED.filter(([field]) => !profile.basics[field]?.toString().trim()).map(([, name]) => name),
    browserAddress: settings.applyBrowserAddress,
    salaryGuide: guide ? describeGuide(guide) : null,
    findPosting: doubtful ? findPostingAt(company, role, followed) : null,
  };
}
