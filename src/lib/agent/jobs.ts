import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { defineJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { loadSettings } from "@/lib/settings-data";

import { agentScanResultSchema, agentSetupProblem, runAgentScan } from "./run";
import { runLimitProblem } from "./runs";

/** Keyed so the schedule and Run now find a run that's queued or running. */
export const AGENT_JOB_KEY = "agent";

/** One run of the job agent (E16-3): one search, then scores; one source request at most. */
export const agentScanJob = defineJob({
  type: "agent-scan",
  input: z.object({ manual: z.boolean() }),
  result: agentScanResultSchema,
  run: (input, context) => runAgentScan(input, context),
});

/**
 * Run now (E16-4), from the Agent screen or from Claude: one more run, at
 * most once an hour after the previous one and within the daily limit. A run
 * already queued or running is reused rather than started again.
 */
export async function startAgentRun(now = new Date()): Promise<{ jobId: string; reused: boolean }> {
  const settings = await loadSettings();
  if (!settings.agentEnabled) throw new ActionError("Turn the job agent on in Settings → Job agent first.");
  const setup = await agentSetupProblem(settings.agentQuery);
  if (setup) throw new ActionError(setup);
  const [unfinished] = await findUnfinishedJobs(AGENT_JOB_KEY);
  if (unfinished) return { jobId: unfinished.id, reused: true };
  const limit = runLimitProblem(settings.agentRuns, now, { manual: true });
  if (limit) throw new ActionError(limit);
  return { jobId: await startJob(agentScanJob, { manual: true }, { key: AGENT_JOB_KEY }), reused: false };
}
