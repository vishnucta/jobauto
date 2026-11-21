import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoundPosting } from "@/lib/job-search/search";
import { storePosting } from "@/lib/postings";
import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";

import { seedBuiltIns } from "../../../prisma/seed/built-ins";
import { MockProvider } from "../ai/providers/mock";

import { prepareApplicationJob, startPreparing } from "./prepare-application";
import type { JobContext } from "./runner";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile(), loadFactTexts: async () => [] };
});
vi.mock("@/lib/notifications/notify", () => ({ emit: vi.fn(async () => 0) }));
// The AI model scores, as Settings → Scoring has it by default (E25-7).
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: async () => true }));
vi.mock("./runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runner")>()),
  startJob: vi.fn(async () => "new-run"),
}));
// A fake AI that answers each step of reading and writing.
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getAiProvider: async () =>
    new MockProvider({
      reply: async (call) => {
        switch (call.json?.name) {
          case "extracted_posting":
            return {
              title: "Regulatory Reporting Analyst · Ledgerly",
              company: "Ledgerly",
              role: "Regulatory Reporting Analyst",
              location: "Frankfurt",
              mode: "Hybrid",
              salary: "",
              deadline: null,
              requirements: [{ text: "Experience with COREP", kind: "skill", skill: "COREP", years: null, language: null }],
              asksForReferences: false,
              language: "English",
            };
          case "posting_factors": {
            const { factorsAnswer } = await import("@/test/scoring");
            return factorsAnswer(call, "high");
          }
          case "tailored_resume":
            return { summary: "Regulatory reporting analyst.", roles: [], projects: [], skills: ["COREP"], education: [] };
          case "cover_letter":
            return { recipient: "Ledgerly · Hiring team", greeting: "Dear Ledgerly team,", paragraphs: [{ label: "Opening", text: "Reporting needs care." }], signOff: "Kind regards," };
          case "application_email":
            return { contactName: null, contactEmail: null, subject: "Application: Regulatory Reporting Analyst", greeting: "Dear Ledgerly team,", paragraphs: ["My documents are attached."], signOff: "Kind regards," };
          default:
            throw new Error(`No answer for ${call.json?.name}`);
        }
      },
    }),
}));

const prisma = () => db.client!;
const found: FoundPosting = {
  source: "JSEARCH",
  externalId: "ledgerly-1",
  title: "Regulatory Reporting Analyst",
  company: "Ledgerly",
  place: "Frankfurt",
  remote: false,
  salary: "",
  postedAt: "2026-11-19T00:00:00.000Z",
  url: "https://ledgerly.example/careers/1",
  via: "",
  description: "Ledgerly is hiring a Regulatory Reporting Analyst for COREP and FINREP.",
  complete: true,
};
const context = (id = "prepare-job"): JobContext => ({ id, step: async () => {}, signal: new AbortController().signal });

beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
});
afterAll(() => prisma().$disconnect());

describe("Prepare it for me (jobauto fork)", () => {
  it("writes a Draft from a kept posting, linked to it, without review", async () => {
    const posting = await storePosting(found);
    await prisma().job.create({ data: { id: "prepare-job", type: "prepare-application", key: `prepare:${posting.id}`, status: "RUNNING", input: { postingId: posting.id } } });
    const result = await prepareApplicationJob.run({ postingId: posting.id }, context());
    expect(result.route).toBe("web");
    const application = await prisma().application.findUniqueOrThrow({ where: { id: result.applicationId }, include: { documents: true } });
    expect(application).toMatchObject({ status: "DRAFT", awaitingReview: false, company: "Ledgerly", postingUrl: found.url });
    expect(application.documents.map((document) => document.kind).sort()).toEqual(["COVER_LETTER", "RESUME"]);
    // Positions shows it as having an application, and the job goes with it.
    expect(await prisma().posting.findUniqueOrThrow({ where: { id: posting.id } })).toMatchObject({ applicationId: result.applicationId });
    expect(await prisma().job.findUniqueOrThrow({ where: { id: "prepare-job" } })).toMatchObject({ applicationId: result.applicationId });
    // The profile last opened, with none scored; its score is kept for Positions (E25-7).
    expect(application.profileId).toBe(TEST_PROFILE_ID);
    expect(await prisma().postingScore.count({ where: { source: found.source, externalId: found.externalId, profileId: TEST_PROFILE_ID } })).toBe(1);
  });

  it("writes it from the profile that fits it best (E24-6, E32-2)", async () => {
    const reporting = await prisma().profile.create({ data: { name: "Reporting", sort: 1, levelFrom: "mid", levelTo: "senior" } });
    const score = (profileId: string, hit: number) =>
      prisma().postingScore.create({
        data: {
          source: found.source,
          externalId: found.externalId,
          profileId,
          score: 50,
          reasons: [],
          redFlags: [],
          scoredWith: "test",
          breakdown: { factors: [], cap: null, requirements: [0, 1, 2].map((index) => ({ text: `R${index}`, mustHave: true, covered: index < hit, evidence: null })) },
        },
      });
    await score(TEST_PROFILE_ID, 1);
    await score(reporting.id, 3);
    const posting = await storePosting(found);
    const result = await prepareApplicationJob.run({ postingId: posting.id }, context());
    expect(await prisma().application.findUniqueOrThrow({ where: { id: result.applicationId } })).toMatchObject({ profileId: reporting.id });
  });

  it("writes the email too when the employer takes applications by email, to the posting's address", async () => {
    const posting = await storePosting({ ...found, url: "", description: `${found.description} Bitte senden Sie Ihre Bewerbung an bewerbung@ledgerly.example.` });
    const result = await prepareApplicationJob.run({ postingId: posting.id }, context());
    expect(result.route).toBe("email");
    const email = await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: result.applicationId, kind: "EMAIL" } } });
    expect(email.units).toMatchObject([{ id: "to", text: "bewerbung@ledgerly.example" }, { id: "subject" }, { id: "body" }]);
  });

  it("makes one application for a posting, however often it runs", async () => {
    const posting = await storePosting(found);
    const [first, second] = await Promise.all([
      prepareApplicationJob.run({ postingId: posting.id }, context("one")),
      prepareApplicationJob.run({ postingId: posting.id }, context("two")),
    ]);
    expect(second.applicationId).toBe(first.applicationId);
    expect((await prepareApplicationJob.run({ postingId: posting.id }, context())).applicationId).toBe(first.applicationId);
    expect(await prisma().application.count()).toBe(1);
  });

  it("refuses a posting with no text to write from", async () => {
    const posting = await storePosting({ ...found, description: "" });
    await expect(prepareApplicationJob.run({ postingId: posting.id }, context())).rejects.toThrow(/no text to write from/);
    expect(await prisma().application.count()).toBe(0);
  });

  it("follows a preparation under way, and answers with one made already", async () => {
    const posting = await storePosting(found);
    expect(await startPreparing(posting.id)).toEqual({ jobId: "new-run", applicationId: null });
    const queued = await prisma().job.create({ data: { type: "prepare-application", key: `prepare:${posting.id}`, status: "QUEUED", input: { postingId: posting.id } } });
    expect(await startPreparing(posting.id)).toEqual({ jobId: queued.id, applicationId: null });
    const { applicationId } = await prepareApplicationJob.run({ postingId: posting.id }, context());
    expect(await startPreparing(posting.id)).toEqual({ jobId: null, applicationId });
    await expect(startPreparing("gone")).rejects.toThrow(/no longer kept/);
  });
});
