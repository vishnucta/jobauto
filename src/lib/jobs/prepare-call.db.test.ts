import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prepJobKey } from "@/lib/call-prep";
import { createTestClient, resetDatabase } from "@/test/db";

import { prepareOnStatus } from "./prepare-call";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
const ai = vi.hoisted(() => ({ usable: true }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => ai.usable }));
// The job is queued, not run: only whether it was started matters here.
vi.mock("./runner", async (importOriginal) => ({ ...(await importOriginal<typeof import("./runner")>()), startJob: vi.fn(async (definition: { type: string }, input: unknown, options: { key?: string; applicationId?: string }) => {
  const job = await db.client!.job.create({ data: { type: definition.type, key: options.key, applicationId: options.applicationId, input: input as object } });
  return job.id;
}) }));
const prisma = () => db.client!;

beforeEach(async () => {
  await resetDatabase(prisma());
  ai.usable = true;
});
afterAll(() => prisma().$disconnect());

const jobsFor = (id: string) => prisma().job.count({ where: { key: prepJobKey(id) } });

describe("prepareOnStatus", () => {
  it("prepares the pack on reaching Screening or Interview, once", async () => {
    const { id } = await prisma().application.create({ data: { company: "Acme" } });
    await prepareOnStatus(id, "SENT");
    expect(await jobsFor(id)).toBe(0);
    await prepareOnStatus(id, "SCREENING");
    expect(await jobsFor(id)).toBe(1);
    // One under way is reused.
    await prepareOnStatus(id, "INTERVIEW");
    expect(await jobsFor(id)).toBe(1);
  });

  it("leaves one that has a pack, and does nothing without an AI provider", async () => {
    const prepared = await prisma().application.create({ data: { company: "Acme", prepWith: "prepare-call@1" } });
    await prepareOnStatus(prepared.id, "INTERVIEW");
    expect(await jobsFor(prepared.id)).toBe(0);
    ai.usable = false;
    const other = await prisma().application.create({ data: { company: "Beta" } });
    await prepareOnStatus(other.id, "SCREENING");
    expect(await jobsFor(other.id)).toBe(0);
  });
});
