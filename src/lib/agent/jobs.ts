import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { defineJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { loadSettings } from "@/lib/settings-data";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { agentScanResultSchema, agentSetupProblem, runAgentScan } from "./run";
import { runLimitProblem } from "./runs";
import { listAgentSearches } from "./searches";

/** Keyed so the schedule and Run now find a run that's queued or running. */
export const AGENT_JOB_KEY = "agent";

/** One run: all enabled searches sequentially, then one shared evaluation. */
export const agentScanJob = defineJob({
  type: "agent-scan",
  input: z.object({ manual: z.boolean() }),
  result: agentScanResultSchema,
  run: (input, context) => runAgentScan(input, context),
});

/**
 * Run all now, from the Agent screen or from Claude: at most once an hour
 * after the previous run and only when the whole enabled batch fits the
 * rolling request quota. A run already queued or running is reused rather
 * than started again.
 */
export async function startAgentRun(now = new Date()): Promise<{ jobId: string; reused: boolean }> {
  const settings = await loadSettings();
  if (!settings.agentEnabled) throw new ActionError("Turn the job agent on in Settings → Job agent first.");
  const setup = await agentSetupProblem();
  if (setup) throw new ActionError(setup);
  const [unfinished] = await findUnfinishedJobs(AGENT_JOB_KEY);
  if (unfinished) return { jobId: unfinished.id, reused: true };
  const requests = (await listAgentSearches()).filter((search) => search.enabled).length;
  const limit = runLimitProblem(settings.agentRuns, now, { manual: true, requests, timeZone: await lastKnownTimeZone() });
  if (limit) throw new ActionError(limit);
  return { jobId: await startJob(agentScanJob, { manual: true }, { key: AGENT_JOB_KEY }), reused: false };
}
