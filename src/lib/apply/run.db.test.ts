import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { resolveAttempt } from "./run";
import { stopWatchingAll } from "./watches";

// Settling a run of the apply assistant by the user's word, as the Apply tab
// and Claude both do. No browser opens: the run is only a row.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});

const prisma = () => db.client!;
const PERSONIO = "https://acme.jobs.personio.de/job/1";

beforeEach(() => resetDatabase(prisma()));
afterEach(() => stopWatchingAll());
afterAll(() => prisma().$disconnect());

/** A Draft with a run waiting for the user at the employer's form. */
async function waitingRun() {
  const application = await prisma().application.create({ data: { company: "Acme", role: "Designer", postingUrl: PERSONIO } });
  const attempt = await prisma().applyAttempt.create({ data: { applicationId: application.id, url: PERSONIO, ats: "personio", status: "WAITING" } });
  return { applicationId: application.id, attemptId: attempt.id };
}

describe("resolveAttempt", () => {
  it("moves a draft to Sent, sent on their site, when the user says she sent it", async () => {
    const { applicationId, attemptId } = await waitingRun();
    expect(await resolveAttempt(attemptId, true)).toBe(true);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: applicationId } })).toMatchObject({ status: "SENT", sentVia: "PORTAL" });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "SUBMITTED", note: "Sent, as you said." });
  });

  it("leaves the application as it was when she says she didn't send it", async () => {
    const { applicationId, attemptId } = await waitingRun();
    expect(await resolveAttempt(attemptId, false)).toBe(true);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: applicationId } })).toMatchObject({ status: "DRAFT", sentVia: null });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: attemptId } })).toMatchObject({ status: "ABANDONED" });
  });

  it("keeps how an application already past Draft went out", async () => {
    const { applicationId, attemptId } = await waitingRun();
    await prisma().application.update({ where: { id: applicationId }, data: { status: "SCREENING", sentVia: "EMAIL" } });
    expect(await resolveAttempt(attemptId, true)).toBe(true);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: applicationId } })).toMatchObject({ status: "SCREENING", sentVia: "EMAIL" });
  });
});
