import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { isAiUsable } from "@/lib/ai/config";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { PRACTICE_JOB_KEY } from "@/lib/jobs/prepare-practice";
import { loadSettings } from "@/lib/settings-data";

import { PrepTab } from "../applications/[id]/prep-tab";

export const metadata: Metadata = { title: "Interview practice" };

/**
 * Interview practice (jobauto fork): the Call prep tab's pack before there's
 * a call, from her profile alone, to print and to practise out loud.
 */
export default async function PracticePage() {
  const [settings, jobs, aiReady] = await Promise.all([loadSettings(), findUnfinishedJobs(PRACTICE_JOB_KEY), isAiUsable()]);
  return (
    <>
      <PageHeader title="Interview practice" description="The questions every first call in Germany asks, with your answers in German you can say and the English beside them." />
      <div className="flex min-h-0 flex-1">
        <PrepTab applicationId="" practice data={{ pack: settings.practicePrep, jobId: jobs.at(-1)?.id ?? null }} aiReady={aiReady} company="" />
      </div>
    </>
  );
}
