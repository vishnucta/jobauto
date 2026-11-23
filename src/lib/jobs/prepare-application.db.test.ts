import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoundPosting } from "@/lib/job-search/search";
import { storePosting } from "@/lib/postings";
import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";

import { seedBuiltIns } from "../../../prisma/seed/built-ins";
import { MockProvider } from "../ai/providers/mock";

import { fullText } from "@/lib/job-search/find";

import { prepareApplicationJob, prepareKept, startPreparing } from "./prepare-application";
import { startJob, type JobContext } from "./runner";

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
// No job portal is asked in a test: the whole text is what a test says it is.
vi.mock("@/lib/job-search/find", () => ({ fullText: vi.fn(async () => null) }));
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
/** The job's input as Positions starts it: the posting alone. */
const postingOnly = (postingId: string) => prepareApplicationJob.input.parse({ postingId });

beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
});
afterAll(() => prisma().$disconnect());

describe("Prepare it for me (jobauto fork)", () => {
  it("writes a Draft from a kept posting, linked to it, without review", async () => {
    const posting = await storePosting(found);
    await prisma().job.create({ data: { id: "prepare-job", type: "prepare-application", key: `prepare:${posting.id}`, status: "RUNNING", input: { postingId: posting.id } } });
    const result = await prepareApplicationJob.run(postingOnly(posting.id), context());
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
    const result = await prepareApplicationJob.run(postingOnly(posting.id), context());
    expect(await prisma().application.findUniqueOrThrow({ where: { id: result.applicationId } })).toMatchObject({ profileId: reporting.id });
  });

  it("writes it from the profile and with the note Claude's draft_application gives (round 2 of the audit)", async () => {
    const reporting = await prisma().profile.create({ data: { name: "Reporting", sort: 1 } });
    const posting = await storePosting(found);
    const result = await prepareApplicationJob.run({ postingId: posting.id, profileId: reporting.id, note: "Stress COREP" }, context());
    const application = await prisma().application.findUniqueOrThrow({ where: { id: result.applicationId }, include: { facts: true } });
    expect(application.profileId).toBe(reporting.id);
    expect(application.facts.map((fact) => fact.text)).toEqual(["Stress COREP"]);
    // Started from draft_application, it goes under the same key, so Positions follows it.
    const other = await storePosting({ ...found, externalId: "ledgerly-2", url: "https://ledgerly.example/careers/2" });
    expect(await startPreparing(other.id, { profileId: reporting.id, note: "Stress COREP" })).toEqual({ jobId: "new-run", applicationId: null });
    expect(vi.mocked(startJob)).toHaveBeenLastCalledWith(prepareApplicationJob, { postingId: other.id, profileId: reporting.id, note: "Stress COREP" }, { key: `prepare:${other.id}` });
  });

  it("writes the email too when the employer takes applications by email, to the posting's address", async () => {
    const posting = await storePosting({ ...found, url: "", description: `${found.description} Bitte senden Sie Ihre Bewerbung an bewerbung@ledgerly.example.` });
    const result = await prepareApplicationJob.run(postingOnly(posting.id), context());
    expect(result.route).toBe("email");
    const email = await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: result.applicationId, kind: "EMAIL" } } });
    expect(email.units).toMatchObject([{ id: "to", text: "bewerbung@ledgerly.example" }, { id: "subject" }, { id: "body" }]);
  });

  it("makes one application for a posting, however often it runs", async () => {
    const posting = await storePosting(found);
    const [first, second] = await Promise.all([
      prepareApplicationJob.run(postingOnly(posting.id), context("one")),
      prepareApplicationJob.run(postingOnly(posting.id), context("two")),
    ]);
    expect(second.applicationId).toBe(first.applicationId);
    expect((await prepareApplicationJob.run(postingOnly(posting.id), context())).applicationId).toBe(first.applicationId);
    expect(await prisma().application.count()).toBe(1);
  });

  it("refuses a posting with no text to write from", async () => {
    const posting = await storePosting({ ...found, description: "" });
    await expect(prepareApplicationJob.run(postingOnly(posting.id), context())).rejects.toThrow(/no text to write from/);
    expect(await prisma().application.count()).toBe(0);
  });

  it("follows a preparation under way, and answers with one made already", async () => {
    const posting = await storePosting(found);
    expect(await startPreparing(posting.id)).toEqual({ jobId: "new-run", applicationId: null });
    const queued = await prisma().job.create({ data: { type: "prepare-application", key: `prepare:${posting.id}`, status: "QUEUED", input: { postingId: posting.id } } });
    expect(await startPreparing(posting.id)).toEqual({ jobId: queued.id, applicationId: null });
    const { applicationId } = await prepareApplicationJob.run(postingOnly(posting.id), context());
    expect(await startPreparing(posting.id)).toEqual({ jobId: null, applicationId });
    await expect(startPreparing("gone")).rejects.toThrow(/no longer kept/);
  });

  it("prepares a kept posting by its id, as the dashboard's row for a posting in her field does, asking for the whole text only when it has just the start", async () => {
    const whole = await storePosting(found);
    expect(await prepareKept(whole.id)).toEqual({ jobId: "new-run", applicationId: null });
    expect(fullText).not.toHaveBeenCalled();
    expect(startJob).toHaveBeenCalledWith(prepareApplicationJob, { postingId: whole.id, profileId: null, note: "" }, { key: `prepare:${whole.id}` });

    const start = await storePosting({ ...found, externalId: "ledgerly-2", url: "https://jobs.example/ledgerly-2", title: "Meldewesen Referent", description: "The start of it…", complete: false });
    vi.mocked(fullText).mockResolvedValueOnce("The whole posting, as the portal has it.");
    await prepareKept(start.id);
    expect(await prisma().posting.findUniqueOrThrow({ where: { id: start.id } })).toMatchObject({ description: "The whole posting, as the portal has it.", complete: true });
    // When the portal has no more, it's prepared from what there is.
    await prisma().posting.update({ where: { id: start.id }, data: { complete: false } });
    vi.mocked(fullText).mockResolvedValueOnce(null);
    expect(await prepareKept(start.id)).toMatchObject({ jobId: expect.any(String) });
    await expect(prepareKept("gone")).rejects.toThrow(/no longer kept/);
  });

  it("makes no second application for a posting the job agent drafted or is drafting (one writer, audit round 2)", async () => {
    const posting = await storePosting(found);
    const draft = await prisma().application.create({ data: { title: "Agent draft", company: "Ledgerly", awaitingReview: true, profileId: TEST_PROFILE_ID } });
    const candidate = await prisma().agentCandidate.create({
      data: { source: found.source, externalId: found.externalId, dedupeKey: "ledgerly|analyst", title: found.title, company: found.company, url: found.url, status: "DRAFTED", applicationId: draft.id, score: 80 },
    });
    // The agent's draft is the posting's application; it stays the agent's to approve.
    expect(await startPreparing(posting.id)).toEqual({ jobId: null, applicationId: draft.id });
    expect((await prepareApplicationJob.run(postingOnly(posting.id), context())).applicationId).toBe(draft.id);
    expect(await prisma().application.count()).toBe(1);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ awaitingReview: true });

    // While the agent writes it, Prepare it for me follows its job.
    await prisma().agentCandidate.update({ where: { id: candidate.id }, data: { status: "DRAFTING", applicationId: null } });
    await prisma().application.delete({ where: { id: draft.id } });
    const drafting = await prisma().job.create({ data: { type: "agent-draft", key: `agent-candidate:${candidate.id}`, status: "RUNNING", input: { candidateId: candidate.id } } });
    expect(await startPreparing(posting.id)).toEqual({ jobId: drafting.id, applicationId: null });
    await expect(prepareApplicationJob.run(postingOnly(posting.id), context())).rejects.toThrow(/job agent is writing/);
    expect(await prisma().application.count()).toBe(0);
  });

  it("answers with an application made from the same link, and keeps it with the posting", async () => {
    const posting = await storePosting(found);
    const made = await prisma().application.create({ data: { title: "By hand", company: "Ledgerly", postingUrl: `${found.url}?utm_source=mail`, profileId: TEST_PROFILE_ID } });
    expect(await startPreparing(posting.id)).toEqual({ jobId: null, applicationId: made.id });
    expect(await prisma().posting.findUniqueOrThrow({ where: { id: posting.id } })).toMatchObject({ applicationId: made.id });
  });

  it("takes the posting out of the job agent's queue once it has its application", async () => {
    const posting = await storePosting(found);
    const candidate = await prisma().agentCandidate.create({
      data: { source: found.source, externalId: found.externalId, dedupeKey: "ledgerly|analyst", title: found.title, company: found.company, url: found.url, status: "SCORED", score: 80 },
    });
    const { applicationId } = await prepareApplicationJob.run(postingOnly(posting.id), context());
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({ status: "APPROVED", applicationId });
  });
});
