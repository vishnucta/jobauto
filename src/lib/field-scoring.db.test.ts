import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AiError } from "@/lib/ai/errors";
import type { FoundPosting } from "@/lib/job-search/search";
import { startJob, type JobContext } from "@/lib/jobs/runner";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";

import { FIELD_SCORING_JOB_KEY, fieldScoringHour, fieldScoringJob, fieldScoringPlan, scoreFieldPostings, startDueFieldScoring } from "./field-scoring";
import { keepFound } from "./library";
import { dismissPosting } from "./postings";

// The daily scoring of new postings in her field (jobauto fork, "Niche
// first"), against the test database, with a scoring model that only counts
// what it's asked. Made-up employers only.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "field-job"),
}));
// The scoring model: what it was asked to score, in order, and whether it's set up or failing.
const model = vi.hoisted(() => ({ asked: [] as string[], problem: null as string | null, failing: false, onScore: (() => {}) as (id: string) => Promise<void> | void }));
vi.mock("@/lib/scoring", () => ({
  scoringProblem: vi.fn(async () => model.problem),
  loadScoringProfile: vi.fn(async () => ({})),
  loadPostingScorer: vi.fn(async () => async (posting: FoundPosting) => {
    model.asked.push(posting.externalId);
    await model.onScore(posting.externalId);
    if (model.failing) throw new AiError("busy", "The scoring model isn't answering.");
    return { data: { score: 70, reasons: ["Fits."], redFlags: [], breakdown: { factors: [], cap: null, requirements: [{ text: "EMIR", mustHave: true, covered: true, evidence: null }] } }, scoredWith: "test" };
  }),
}));

const prisma = () => db.client!;
// 10:00 in Berlin, on a Wednesday.
const now = new Date("2026-11-25T09:00:00.000Z");
const context: Pick<JobContext, "step" | "signal"> = { step: async () => {}, signal: new AbortController().signal };

const posting = (id: string, title: string, extra: Partial<FoundPosting> = {}): FoundPosting => ({
  source: "JSEARCH",
  externalId: id,
  title,
  company: `Employer ${id}`,
  place: "Hamburg",
  remote: null,
  salary: "",
  postedAt: "2026-11-20T00:00:00.000Z",
  url: `https://jobs.example/${id}`,
  via: "",
  description: "We are looking for a colleague. Our team works in English.",
  complete: true,
  ...extra,
});
/** Keeps postings as found at `at`, oldest first: each a minute after the one before. */
const keep = async (found: FoundPosting[], at = new Date("2026-11-24T08:00:00.000Z")) => {
  const search = await prisma().postingSearch.create({ data: { query: { keywords: "reporting" } }, select: { id: true } });
  await keepFound(search.id, "JSEARCH", found, { now: at });
  for (const [index, entry] of found.entries()) {
    await prisma().posting.update({ where: { source_externalId: { source: "JSEARCH", externalId: entry.externalId } }, data: { createdAt: new Date(at.getTime() + index * 60_000) } });
  }
};
const marked = (count: number, prefix = "p") => Array.from({ length: count }, (_, index) => posting(`${prefix}${index + 1}`, `Regulatory Reporting Analyst ${prefix}${index + 1}`));
const scoresKept = async () => (await prisma().postingScore.findMany({ select: { externalId: true, profileId: true }, orderBy: { externalId: "asc" } })).map((row) => row.externalId);
const agentJob = (status: "QUEUED" | "RUNNING" | "DONE") => prisma().job.create({ data: { type: "agent-scan", key: "agent", status, input: { manual: false } } });

beforeEach(async () => {
  await resetDatabase(prisma());
  await prisma().profile.update({ where: { id: TEST_PROFILE_ID }, data: { headline: "Regulatory Reporting Analyst" } });
  await saveSettings({ browserTimeZone: "Europe/Berlin" });
  model.asked = [];
  model.problem = null;
  model.failing = false;
  model.onScore = () => {};
  vi.mocked(startJob).mockClear();
});
afterAll(() => prisma().$disconnect());

describe("what the daily scoring takes", () => {
  it("scores the day's number of new marked postings, the newest found first, and keeps each score where Positions reads it", async () => {
    await keep([...marked(7), posting("other", "Product Designer")]);
    expect((await loadSettings()).fieldScoresPerDay).toBe(5);
    const result = await scoreFieldPostings(context, now);
    expect(result).toEqual({ scored: 5, message: "Scored 5 new postings in your field." });
    expect(model.asked).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    expect(await scoresKept()).toEqual(["p3", "p4", "p5", "p6", "p7"]);
    expect((await prisma().postingScore.findFirstOrThrow()).profileId).toBe(TEST_PROFILE_ID);
    expect((await loadSettings()).fieldScored).toEqual({ day: "2026-11-25", count: 5 });
  });

  it("holds the day's number across runs, and starts again the next day", async () => {
    await keep(marked(8));
    await scoreFieldPostings(context, now);
    // The same day: nothing more, whatever is still unscored.
    expect(await fieldScoringPlan(new Date("2026-11-25T15:00:00.000Z"))).toBeNull();
    expect((await scoreFieldPostings(context, new Date("2026-11-25T15:00:00.000Z"))).scored).toBe(0);
    expect(model.asked).toHaveLength(5);
    // The next day: the three left, never one scored before.
    const next = await scoreFieldPostings(context, new Date("2026-11-26T09:00:00.000Z"));
    expect(next.scored).toBe(3);
    expect(model.asked.slice(5)).toEqual(["p3", "p2", "p1"]);
    expect((await loadSettings()).fieldScored).toEqual({ day: "2026-11-26", count: 3 });
  });

  it("follows the number in Settings, and 0 switches it off", async () => {
    await keep(marked(4));
    await saveSettings({ fieldScoresPerDay: 2 });
    expect((await scoreFieldPostings(context, now)).scored).toBe(2);
    // Raised later the same day: the difference is still open.
    await saveSettings({ fieldScoresPerDay: 3 });
    expect((await scoreFieldPostings(context, now)).scored).toBe(1);
    await saveSettings({ fieldScoresPerDay: 0 });
    expect(await fieldScoringPlan(new Date("2026-11-26T09:00:00.000Z"))).toBeNull();
    expect(model.asked).toHaveLength(3);
  });

  it("never scores one that has a score, that she dismissed or applied to, that is older than a week, or that needs far more German than she has", async () => {
    await prisma().language.create({ data: { name: "German", level: "A2" } });
    await keep([
      posting("scored", "Meldewesen Referent"),
      posting("dismissed", "Transaction Reporting Analyst"),
      posting("applied", "COREP Analyst"),
      posting("german", "EMIR Analyst", { description: "Sie bringen verhandlungssichere Deutschkenntnisse (C1) mit." }),
      posting("fresh", "Regulatory Reporting Specialist"),
    ]);
    await keep([posting("old", "MiFIR Analyst")], new Date("2026-11-10T08:00:00.000Z"));
    await prisma().postingScore.create({ data: { source: "JSEARCH", externalId: "scored", profileId: TEST_PROFILE_ID, score: 40, reasons: [], redFlags: [], scoredWith: "by hand" } });
    await dismissPosting(posting("dismissed", "Transaction Reporting Analyst"));
    const application = await prisma().application.create({ data: { title: "A", company: "E", role: "R" }, select: { id: true } });
    await prisma().posting.update({ where: { source_externalId: { source: "JSEARCH", externalId: "applied" } }, data: { applicationId: application.id } });

    expect((await fieldScoringPlan(now))?.postings.map((entry) => entry.externalId)).toEqual(["fresh"]);
    expect((await scoreFieldPostings(context, now)).scored).toBe(1);
    expect(model.asked).toEqual(["fresh"]);
    // The score kept by hand is still the one it has.
    expect((await prisma().postingScore.findFirstOrThrow({ where: { externalId: "scored" } })).scoredWith).toBe("by hand");
  });

  it("doesn't score one again that was scored between the plan and its turn", async () => {
    await keep(marked(3));
    model.onScore = async (id) => {
      // While the first is scored, she presses Score on the next.
      if (id === "p3") await prisma().postingScore.create({ data: { source: "JSEARCH", externalId: "p2", profileId: TEST_PROFILE_ID, score: 55, reasons: [], redFlags: [], scoredWith: "by hand" } });
    };
    expect((await scoreFieldPostings(context, now)).scored).toBe(2);
    expect(model.asked).toEqual(["p3", "p1"]);
    expect((await loadSettings()).fieldScored).toEqual({ day: "2026-11-25", count: 2 });
  });
});

describe("when it costs nothing", () => {
  it("does nothing while no profile is in the field", async () => {
    await prisma().profile.update({ where: { id: TEST_PROFILE_ID }, data: { headline: "Product Designer" } });
    await keep(marked(2));
    expect(await fieldScoringPlan(now)).toBeNull();
    expect(await scoreFieldPostings(context, now)).toEqual({ scored: 0, message: "Nothing in your field to score now." });
    expect(model.asked).toEqual([]);
  });

  it("does nothing while scoring is off: no scoring model, or the profile's levels not chosen", async () => {
    await keep(marked(2));
    model.problem = "Set up an AI provider first.";
    expect(await fieldScoringPlan(now)).toBeNull();
    model.problem = null;
    await prisma().profile.update({ where: { id: TEST_PROFILE_ID }, data: { levelFrom: null, levelTo: null } });
    expect(await fieldScoringPlan(now)).toBeNull();
    expect((await scoreFieldPostings(context, now)).scored).toBe(0);
    expect(model.asked).toEqual([]);
    expect(await scoresKept()).toEqual([]);
    expect((await loadSettings()).fieldScored).toBeNull();
  });

  it("stops at a scoring model that isn't answering, and counts nothing for it", async () => {
    await keep(marked(3));
    model.failing = true;
    expect(await scoreFieldPostings(context, now)).toEqual({ scored: 0, message: "The scoring model isn't answering." });
    expect(model.asked).toEqual(["p3"]);
    expect((await loadSettings()).fieldScored).toBeNull();
  });
});

describe("beside the job agent", () => {
  it("waits while an agent run is queued or going, and stops when one starts meanwhile", async () => {
    await keep(marked(3));
    const run = await agentJob("RUNNING");
    expect(await fieldScoringPlan(now)).toBeNull();
    await prisma().job.update({ where: { id: run.id }, data: { status: "DONE" } });
    expect((await fieldScoringPlan(now))?.postings).toHaveLength(3);

    model.onScore = async (id) => {
      if (id === "p3") await agentJob("QUEUED");
    };
    expect((await scoreFieldPostings(context, now)).scored).toBe(1);
    expect(model.asked).toEqual(["p3"]);
  });

  it("leaves a posting the agent scored as it is: its score is the one Positions has", async () => {
    await keep(marked(2));
    await prisma().postingScore.create({ data: { source: "JSEARCH", externalId: "p2", profileId: TEST_PROFILE_ID, score: 90, reasons: [], redFlags: [], scoredWith: "the agent" } });
    await scoreFieldPostings(context, now);
    expect(model.asked).toEqual(["p1"]);
  });
});

describe("the daily timer", () => {
  it("starts from 08:00 in her time zone", () => {
    expect(fieldScoringHour(new Date("2026-11-25T06:30:00.000Z"), "Europe/Berlin")).toBe(false);
    expect(fieldScoringHour(new Date("2026-11-25T07:00:00.000Z"), "Europe/Berlin")).toBe(true);
    expect(fieldScoringHour(new Date("2026-11-25T07:00:00.000Z"), "UTC")).toBe(false);
  });

  it("starts a scoring only when it's past the hour, there's something to score, and none is queued or running", async () => {
    await keep(marked(1));
    expect(await startDueFieldScoring(new Date("2026-11-25T05:00:00.000Z"))).toBeNull();
    expect(await startDueFieldScoring(now)).toBe("field-job");
    expect(startJob).toHaveBeenCalledWith(fieldScoringJob, {}, { key: FIELD_SCORING_JOB_KEY });

    vi.mocked(startJob).mockClear();
    await prisma().job.create({ data: { type: "field-scoring", key: FIELD_SCORING_JOB_KEY, status: "RUNNING", input: {} } });
    expect(await startDueFieldScoring(now)).toBeNull();
    await prisma().job.deleteMany();
    await saveSettings({ fieldScoresPerDay: 0 });
    expect(await startDueFieldScoring(now)).toBeNull();
    expect(startJob).not.toHaveBeenCalled();
  });
});
