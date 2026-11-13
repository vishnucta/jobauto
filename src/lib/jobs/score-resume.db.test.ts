import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { scoreResumeJob } from "./score-resume";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile() };
});
vi.mock("@/lib/settings-data", () => ({ loadSettings: async () => ({ resumeSections: { order: [], off: [] } }) }));
const scorer = vi.hoisted(() => ({ calls: [] as { posting: unknown; summary: string }[] }));
vi.mock("@/lib/scoring", () => ({
  loadPostingScorer: async () => async (posting: unknown, profile: { basics: { summary: string } }) => {
    scorer.calls.push({ posting, summary: profile.basics.summary });
    return { data: { score: 82, reasons: ["Payments, as the posting asks"], redFlags: [] }, scoredWith: "score-posting-jev@1" };
  },
}));
vi.mock("./runner", () => ({ defineJob: <T,>(definition: T) => definition }));

const prisma = () => db.client!;
const context = { id: "test-job", step: async () => {}, signal: new AbortController().signal };

beforeEach(async () => {
  await resetDatabase(prisma());
  scorer.calls = [];
  await prisma().application.create({
    data: {
      id: "app-1",
      company: "Ledgerly",
      role: "Designer",
      location: "Amsterdam",
      mode: "Remote",
      postingText: "Ledgerly is hiring a Designer.",
      documents: { create: [{ kind: "RESUME", units: [{ id: "summary", label: "Summary", text: "Payments designer." }] }] },
    },
  });
  await prisma().application.create({ data: { id: "app-2", company: "Acme", postingText: "Acme." } });
});
afterAll(() => prisma().$disconnect());

describe("scoreResumeJob (#370)", () => {
  it("scores the tailored resume against the posting and keeps the score on the application", async () => {
    const fit = await scoreResumeJob.run({ applicationId: "app-1" }, context);
    expect(fit).toMatchObject({ score: 82, scoredWith: "score-posting-jev@1" });
    expect(scorer.calls).toEqual([
      { posting: { title: "Designer", company: "Ledgerly", place: "Amsterdam", remote: true, salary: "", description: "Ledgerly is hiring a Designer." }, summary: "Payments designer." },
    ]);
    expect((await prisma().application.findUniqueOrThrow({ where: { id: "app-1" } })).resumeFit).toMatchObject({ score: 82, reasons: ["Payments, as the posting asks"] });
  });

  it("says so for an application without a tailored resume", async () => {
    await expect(scoreResumeJob.run({ applicationId: "app-2" }, context)).rejects.toThrow("no tailored resume");
  });
});
