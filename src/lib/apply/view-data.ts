import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { applyJobKey } from "@/lib/jobs/apply";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { prisma } from "@/lib/prisma";
import type { Basics } from "@/lib/profile";
import type { SettingsData } from "@/lib/settings";

import { hostOf } from "./ats";
import { planFor } from "./plan";
import { isWatching } from "./watches";
import { filledSchema, unfilledSchema } from "./run-types";
import type { ApplyAttemptView, ApplyPlanView, ApplyTabData } from "./view";

const ATTEMPTS_SHOWN = 8;

/** The basics forms nearly always ask for. */
const ASKED: readonly [keyof Basics, string][] = [
  ["phone", "phone number"],
  ["address", "street address"],
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
  application: { id: string; postingUrl: string; postingText: string; documents: { kind: DocumentKind }[] },
  profile: { basics: Basics },
  settings: Pick<SettingsData, "applyAnswers">,
  timeZone: string | undefined,
): Promise<ApplyTabData> {
  const [posting, rows, jobs] = await Promise.all([
    prisma.posting.findUnique({ where: { applicationId: application.id }, select: { url: true, source: true } }),
    prisma.applyAttempt.findMany({ where: { applicationId: application.id }, orderBy: { startedAt: "desc" }, take: ATTEMPTS_SHOWN }),
    findUnfinishedJobs(applyJobKey(application.id)),
  ]);
  const route = planFor({ postingUrl: application.postingUrl, postingText: application.postingText, posting });
  const plan: ApplyPlanView =
    route.kind === "web"
      ? { kind: "web", url: route.url, host: route.host, atsLabel: route.ats.label, account: route.ats.account, autoSubmitOk: route.ats.autoSubmit, board: route.ats.board }
      : route;
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
  };
}
