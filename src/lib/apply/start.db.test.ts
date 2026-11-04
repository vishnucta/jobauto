import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyJob, applyPageJob } from "@/lib/jobs/apply";
import { startJob } from "@/lib/jobs/runner";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { DEFAULT_APPLY_ANSWERS } from "./answers";
import { startApplyRun, startFillPage } from "./start";
import { addWatch, stopWatchingAll } from "./watches";

// Starting a run of the apply assistant, as the Apply tab and Claude both do.
// No browser opens: startJob is mocked, so the run's job only gets an id.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "apply-job"),
}));

const prisma = () => db.client!;

beforeEach(async () => {
  await resetDatabase(prisma());
  vi.mocked(startJob).mockClear();
});
afterEach(() => stopWatchingAll());
afterAll(() => prisma().$disconnect());

/** An application with a resume, applied for at `postingUrl`. */
const application = (postingUrl: string) =>
  prisma().application.create({ data: { company: "Acme", role: "Designer", postingUrl, documents: { create: { kind: "RESUME", units: [] } } } });

/** Whether the run started for an application may press Send. */
async function pressesSend(id: string, mayPressSend: boolean): Promise<boolean> {
  const started = await startApplyRun(id, { mayPressSend });
  if (!started.ok || !started.attemptId) throw new Error("The run didn't start.");
  expect(startJob).toHaveBeenLastCalledWith(applyJob, { applicationId: id, attemptId: started.attemptId }, { key: `apply:${id}`, applicationId: id });
  return (await prisma().applyAttempt.findUniqueOrThrow({ where: { id: started.attemptId } })).autoSubmit;
}

/** The server watching a run's browser tab, as it does while the user is at the form. */
const watching = (attemptId: string) => addWatch(attemptId, { page: {} as Page, timer: setInterval(() => {}, 60_000) });

describe("startFillPage", () => {
  it("fills the page for the run waiting for the user, in the window the server is watching", async () => {
    const app = await application("https://acme.jobs.personio.de/job/1");
    const waiting = await prisma().applyAttempt.create({ data: { applicationId: app.id, url: "https://acme.jobs.personio.de/job/1", ats: "personio", status: "WAITING" } });
    watching(waiting.id);
    expect(await startFillPage(app.id)).toEqual({ ok: true, jobId: "apply-job", attemptId: waiting.id, alreadyRunning: false });
    // Under the run's own key, so a run and a fill never work on one application together.
    expect(startJob).toHaveBeenLastCalledWith(applyPageJob, { applicationId: app.id, attemptId: waiting.id }, { key: `apply:${app.id}`, applicationId: app.id });
  });

  it("takes the newest of the runs still open, and none that ended", async () => {
    const app = await application("https://acme.jobs.personio.de/job/1");
    const data = { applicationId: app.id, url: "https://acme.jobs.personio.de/job/1", ats: "personio" };
    await prisma().applyAttempt.create({ data: { ...data, status: "WAITING", startedAt: new Date("2026-11-03T10:00:00Z") } });
    const newest = await prisma().applyAttempt.create({ data: { ...data, status: "WAITING", startedAt: new Date("2026-11-03T11:00:00Z") } });
    await prisma().applyAttempt.create({ data: { ...data, status: "SUBMITTED", startedAt: new Date("2026-11-03T12:00:00Z") } });
    watching(newest.id);
    expect(await startFillPage(app.id)).toMatchObject({ ok: true, attemptId: newest.id });
  });

  it("follows the run or fill that is going instead of starting a second", async () => {
    const app = await application("https://acme.jobs.personio.de/job/1");
    const waiting = await prisma().applyAttempt.create({ data: { applicationId: app.id, url: "https://acme.jobs.personio.de/job/1", ats: "personio", status: "WAITING" } });
    watching(waiting.id);
    const going = await prisma().job.create({ data: { type: "apply-page", key: `apply:${app.id}`, applicationId: app.id, status: "RUNNING", input: { applicationId: app.id, attemptId: waiting.id } } });
    expect(await startFillPage(app.id)).toEqual({ ok: true, jobId: going.id, attemptId: waiting.id, alreadyRunning: true });
    expect(startJob).not.toHaveBeenCalled();
  });

  it("says why nothing started, in the Apply tab's words", async () => {
    expect(await startFillPage("gone")).toEqual({ ok: false, problem: "gone", message: "That application no longer exists." });
    const app = await application("https://acme.jobs.personio.de/job/1");
    expect(await startFillPage(app.id)).toMatchObject({ ok: false, problem: "no-run", message: expect.stringContaining("no run waiting for you") });
    // A run that ended has no window to fill.
    await prisma().applyAttempt.create({ data: { applicationId: app.id, url: "https://acme.jobs.personio.de/job/1", ats: "personio", status: "FAILED" } });
    expect(await startFillPage(app.id)).toMatchObject({ ok: false, problem: "no-run" });
    // Waiting, but the server was restarted since: the window is out of reach.
    await prisma().applyAttempt.create({ data: { applicationId: app.id, url: "https://acme.jobs.personio.de/job/1", ats: "personio", status: "WAITING" } });
    expect(await startFillPage(app.id)).toMatchObject({ ok: false, problem: "not-watched", message: expect.stringContaining("I'm not watching the browser window any more") });
    expect(startJob).not.toHaveBeenCalled();
  });
});

describe("startApplyRun", () => {
  it("lets a run press Send only where the caller, the saved answers and the job system all allow it", async () => {
    const personio = await application("https://acme.jobs.personio.de/job/1");
    const workday = await application("https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1");

    expect(await pressesSend(personio.id, true)).toBe(false);
    await saveSettings({ applyAnswers: { ...DEFAULT_APPLY_ANSWERS, autoSubmit: true } });
    expect(await pressesSend(personio.id, true)).toBe(true);
    expect(await pressesSend(personio.id, false)).toBe(false);
    expect(await pressesSend(workday.id, true)).toBe(false);
  });

  it("says why nothing started, in the Apply tab's words", async () => {
    expect(await startApplyRun("gone", { mayPressSend: true })).toEqual({ ok: false, problem: "gone", message: "That application no longer exists." });
    const none = await application("");
    expect(await startApplyRun(none.id, { mayPressSend: true })).toMatchObject({ ok: false, problem: "no-link" });
    expect(startJob).not.toHaveBeenCalled();
  });
});
