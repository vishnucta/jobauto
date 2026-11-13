import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { nextSourceBudgetAt, recordRunEnd, recordSourceRequest, reserveRun, runLimitProblem, sourceRequestsInPastDay } from "./runs";
import { checkAgentSchedule, nextAgentRun, startDueRun } from "./schedule";
import { saveAgentSearch } from "./searches";
import { EMPTY_QUERY } from "@/lib/job-search/search";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/time-zone", () => ({ lastKnownTimeZone: async () => "UTC" }));
vi.mock("@/lib/jobs/runner", async (original) => ({ ...(await original<typeof import("@/lib/jobs/runner")>()), startJob: vi.fn(async () => "scheduled") }));
const prisma = () => db.client!;
const now = new Date("2026-10-20T07:00:00Z");
const day = 86_400_000;
beforeEach(async () => { await resetDatabase(prisma()); });
afterAll(() => prisma().$disconnect());

describe("durable source-request budget", () => {
  it("admits only one concurrent two-slot reservation and preserves it across clients/restarts", async () => {
    const reservations = await Promise.all([reserveRun(now, false, 2), reserveRun(now, false, 2)]);
    expect(reservations.filter((run) => typeof run !== "string")).toHaveLength(1);
    const otherClient = createTestClient();
    try {
      const ledger = await otherClient.setting.findUniqueOrThrow({ where: { key: "agentRuns" } });
      expect(JSON.parse(ledger.value)).toMatchObject([{ sourceRequests: 2 }]);
    } finally { await otherClient.$disconnect(); }
    // New process can only read the same durable reservations, not reset quota.
    expect(await reserveRun(new Date(now.getTime() + 3_600_000), false, 2)).toContain("Next eligible");
    expect(sourceRequestsInPastDay((await loadSettings()).agentRuns, now)).toBe(2);
  });

  it("waits for enough slots for the whole run, and admits at the exact 24h boundary", async () => {
    await reserveRun(now, false, 1);
    const later = new Date(now.getTime() + 5_000);
    await reserveRun(later, false, 2);
    const boundary = new Date(now.getTime() + day);
    const runs = (await loadSettings()).agentRuns;
    expect(nextSourceBudgetAt(runs, boundary, 3)).toEqual(new Date(later.getTime() + day));
    expect(runLimitProblem(runs, new Date(later.getTime() + day - 1), { manual: false, requests: 3 })).not.toBeNull();
    expect(typeof await reserveRun(new Date(later.getTime() + day), false, 3)).toBe("object");
  });

  it("counts attempts at dispatch, not just reservation time, including the last slow search", async () => {
    const run = await reserveRun(now, false, 3);
    if (typeof run === "string") throw new Error(run);
    await recordSourceRequest(run, 0, now);
    await recordSourceRequest(run, 1, new Date(now.getTime() + 3_000));
    await recordSourceRequest(run, 2, new Date(now.getTime() + 6_000));
    const boundary = new Date(now.getTime() + day);
    const runs = (await loadSettings()).agentRuns;
    expect(sourceRequestsInPastDay(runs, boundary)).toBe(2);
    expect(nextSourceBudgetAt(runs, boundary, 3)).toEqual(new Date(boundary.getTime() + 6_000));
    expect(await reserveRun(new Date(boundary.getTime() + 5_999), false, 3)).toContain("Next eligible");
    expect(typeof await reserveRun(new Date(boundary.getTime() + 6_000), false, 3)).toBe("object");
  });

  it("doesn't lose concurrent end updates or source reservations", async () => {
    const run = await reserveRun(now, false, 1);
    if (typeof run === "string") throw new Error(run);
    await Promise.all([
      recordRunEnd(run, "Finished", [{ searchId: "a", searchName: "A", found: 1, fresh: 1, error: null }]),
      reserveRun(new Date(now.getTime() + 1), false, 2),
    ]);
    const runs = (await loadSettings()).agentRuns;
    expect(sourceRequestsInPastDay(runs, new Date(now.getTime() + 2))).toBe(3);
    expect(runs.find((entry) => entry.at === run.at)?.message).toBe("Finished");
  });

  it("admits tomorrow's daily tick when all three reserved request slots have expired", async () => {
    await saveSettings({ agentEnabled: true, agentHour: 7 });
    for (let i = 0; i < 3; i++) await saveAgentSearch({ name: `Search ${i}`, query: { ...EMPTY_QUERY, keywords: `Job ${i}`, country: "nl" }, sort: i, enabled: true });
    const run = await reserveRun(now, false, 3);
    if (typeof run === "string") throw new Error(run);
    await recordRunEnd(run, "Finished seconds later");
    const tomorrow = new Date(now.getTime() + day);
    const runs = (await loadSettings()).agentRuns;
    expect(nextAgentRun(now, 7, "UTC", runs, 3)).toEqual(tomorrow);
    expect(await startDueRun(new Date(tomorrow.getTime() - 1))).toBeNull();
    expect(await startDueRun(tomorrow)).toBe("scheduled");
  });

  it("wakes at budget expiry seconds after a daily tick, rather than drifting another 15 minutes", async () => {
    await saveAgentSearch({ name: "Search", query: { ...EMPTY_QUERY, keywords: "Designer", country: "nl" }, sort: 0, enabled: true });
    await saveSettings({ agentEnabled: true, agentHour: 7, agentRuns: [{ at: new Date(now.getTime() - day + 5_000).toISOString(), sourceRequests: 3, manual: false, message: "Finished" }] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      const runs = (await loadSettings()).agentRuns;
      expect(nextAgentRun(now, 7, "UTC", runs, 1)).toEqual(new Date(now.getTime() + 5_000));
      await checkAgentSchedule();
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 5_000);
    } finally {
      for (const result of timer.mock.results) if (result.type === "return") clearTimeout(result.value);
      timer.mockRestore();
      vi.useRealTimers();
    }
  });
});
