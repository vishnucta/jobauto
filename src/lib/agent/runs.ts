import "server-only";

import { lockForTransaction } from "@/lib/db-lock";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/dates";
import { AGENT_MAX_SOURCE_REQUESTS_PER_DAY } from "./limits";
import { AGENT_RUNS_KEPT, settingsFromRows, type AgentRun, type AgentSearchRun } from "@/lib/settings";

/** Serializes the run ledger's writes (public PR 61). */
const RUNS_LOCK = 621746002;

/** Source-request slots, not runs. Failed requests consume slots too. */
export { AGENT_MAX_SOURCE_REQUESTS_PER_DAY } from "./limits";
export const AGENT_MANUAL_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const requestTimes = (run: AgentRun): string[] =>
  Array.from({ length: run.sourceRequests ?? 1 }, (_, index) => run.sourceRequestAts?.[index] ?? run.at);

export const sourceRequestsInPastDay = (runs: readonly AgentRun[], now: Date) =>
  runs.flatMap(requestTimes).filter((at) => Date.parse(at) + DAY_MS > now.getTime()).length;

export function interruptedRunMessage(run: AgentRun): string {
  const requests = run.sourceRequests ?? 1;
  return `The agent scan was interrupted. All ${requests} reserved source ${requests === 1 ? "request still counts" : "requests still count"} toward the 24-hour limit, including any not sent.`;
}

/** Whole-run admission: wait until all enabled searches fit, never run a subset. */
export function nextSourceBudgetAt(runs: readonly AgentRun[], now: Date, requests = 1): Date {
  const recent = runs.flatMap(requestTimes).map(Date.parse).filter((at) => at + DAY_MS > now.getTime()).toSorted((a, b) => a - b);
  let used = sourceRequestsInPastDay(runs, now);
  // Expire oldest slots one at a time until the ENTIRE requested batch fits.
  // At exactly timestamp + 24h a slot is free (the rolling window is open
  // at its older boundary), including the last request of a slow prior run.
  for (const at of recent) {
    if (used + requests <= AGENT_MAX_SOURCE_REQUESTS_PER_DAY) break;
    used -= 1;
    if (used + requests <= AGENT_MAX_SOURCE_REQUESTS_PER_DAY) return new Date(at + DAY_MS);
  }
  return now;
}

/** Call only while owning the session scan lock: null messages can otherwise
 * belong to a live scan. Retain all reservations after a crash, even unused
 * ones, because source dispatch and database writes cannot be one transaction.
 */
export async function reconcileInterruptedRuns(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockForTransaction(tx, RUNS_LOCK);
    const runs = settingsFromRows(await tx.setting.findMany({ where: { key: "agentRuns" } })).agentRuns;
    if (!runs.some((run) => run.message === null)) return;
    for (const run of runs) {
      if (run.message !== null) continue;
      run.message = interruptedRunMessage(run);
    }
    await tx.setting.update({ where: { key: "agentRuns" }, data: { value: JSON.stringify(runs) } });
  });
}

export function runLimitProblem(runs: readonly AgentRun[], now: Date, { manual, requests = 1, timeZone = "UTC" }: { manual: boolean; requests?: number; timeZone?: string }): string | null {
  const free = nextSourceBudgetAt(runs, now, requests);
  if (free > now) return `The agent needs ${requests} source ${requests === 1 ? "request" : "requests"}, but may use only ${AGENT_MAX_SOURCE_REQUESTS_PER_DAY} in 24 hours. Next eligible: ${formatDateTime(free, timeZone, now)} (${timeZone}).`;
  const last = runs[0];
  if (manual && last && Date.parse(last.at) + AGENT_MANUAL_INTERVAL_MS > now.getTime()) {
    const minutes = Math.ceil((Date.parse(last.at) + AGENT_MANUAL_INTERVAL_MS - now.getTime()) / 60_000);
    return `The agent ran less than an hour ago. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  return null;
}

/** Atomic, durable reservation. A crash conservatively spends reserved slots.
 * Dispatch advances each slot to the actual attempt time. The scheduler
 * wakes at expiry so a daily run doesn't drift by a tick per day.
 */
export async function reserveRun(now: Date, manual: boolean, requests: number, timeZone = "UTC"): Promise<AgentRun | string> {
  if (!Number.isInteger(requests) || requests < 1 || requests > AGENT_MAX_SOURCE_REQUESTS_PER_DAY) throw new Error("Invalid Agent source reservation");
  return prisma.$transaction(async (tx) => {
    await lockForTransaction(tx, RUNS_LOCK);
    const runs = settingsFromRows(await tx.setting.findMany({ where: { key: "agentRuns" } })).agentRuns;
    const problem = runLimitProblem(runs, now, { manual, requests, timeZone });
    if (problem) return problem;
    const run: AgentRun = { at: now.toISOString(), manual, message: null, sourceRequests: requests, sourceRequestAts: Array(requests).fill(now.toISOString()), searches: [] };
    const value = JSON.stringify([run, ...runs].slice(0, AGENT_RUNS_KEPT));
    await tx.setting.upsert({ where: { key: "agentRuns" }, create: { key: "agentRuns", value }, update: { value } });
    return run;
  });
}

/** Persist immediately before dispatch, including requests that will fail. */
export async function recordSourceRequest(run: AgentRun, index: number, now: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockForTransaction(tx, RUNS_LOCK);
    const runs = settingsFromRows(await tx.setting.findMany({ where: { key: "agentRuns" } })).agentRuns;
    const entry = runs.find((entry) => entry.at === run.at);
    if (!entry || index < 0 || index >= (entry.sourceRequests ?? 1)) throw new Error("Agent source reservation no longer exists");
    const times = requestTimes(entry);
    times[index] = now.toISOString();
    entry.sourceRequestAts = times;
    await tx.setting.update({ where: { key: "agentRuns" }, data: { value: JSON.stringify(runs) } });
  });
}

/** Update under the same lock as admission so concurrent writers can't lose slots. */
export async function recordRunEnd(run: AgentRun, message: string | null, searches?: AgentSearchRun[]): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockForTransaction(tx, RUNS_LOCK);
    const runs = settingsFromRows(await tx.setting.findMany({ where: { key: "agentRuns" } })).agentRuns;
    const value = JSON.stringify(runs.map((entry) => entry.at === run.at ? { ...entry, message, ...(searches ? { searches } : {}) } : entry));
    await tx.setting.upsert({ where: { key: "agentRuns" }, create: { key: "agentRuns", value }, update: { value } });
  });
}
