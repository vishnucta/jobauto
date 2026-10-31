import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyJob } from "@/lib/jobs/apply";
import { startJob } from "@/lib/jobs/runner";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { DEFAULT_APPLY_ANSWERS } from "./answers";
import { startApplyRun } from "./start";

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
