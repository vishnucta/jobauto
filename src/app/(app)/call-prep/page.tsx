import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { isAiUsable } from "@/lib/ai/config";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { PRACTICE_JOB_KEY } from "@/lib/jobs/prepare-practice";
import { loadSettings } from "@/lib/settings-data";

import { PrepTab } from "../applications/[id]/prep-tab";

export const metadata: Metadata = { title: "Call prep" };

/**
 * Call prep's general practice (jobauto fork): the Call prep tab's pack
 * before there's a call, from her profile alone, to print and to practise
 * out loud. It was Interview practice, a page of its own; now it's Call
 * prep's other mode, reached from the dashboard and an application's
 * Interview panel and Call prep tab (/practice comes here).
 */
export default async function CallPrepPage() {
  const [settings, jobs, aiReady] = await Promise.all([loadSettings(), findUnfinishedJobs(PRACTICE_JOB_KEY), isAiUsable()]);
  return (
    <>
      <PageHeader
        title="Call prep · general practice"
        description="The questions every first call in Germany asks, from your profile, with your answers in German you can say and the English beside them. Each application gets its own pack on its Call prep tab."
      />
      <div className="flex min-h-0 flex-1">
        <PrepTab applicationId="" practice data={{ pack: settings.practicePrep, jobId: jobs.at(-1)?.id ?? null }} aiReady={aiReady} company="" />
      </div>
    </>
  );
}
