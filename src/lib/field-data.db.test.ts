import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FoundPosting } from "@/lib/job-search/search";
import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";

import { fieldProfiles, hasFieldProfile, loadFieldPicks, loadFieldWeek } from "./field-data";
import { keepFound, listLibrary } from "./library";
import { DEFAULT_FILTERS } from "./job-search/search";
import { dismissPosting } from "./postings";

// In your field, read from the database (jobauto fork, "Niche first"), with a
// made-up profile and made-up employers.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const prisma = () => db.client!;

// A Wednesday: its week runs from Monday 23 to Sunday 29 November in her time zone.
const now = new Date("2026-11-25T10:00:00.000Z");
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
const keep = async (found: FoundPosting[], at = now) => {
  const search = await prisma().postingSearch.create({ data: { query: { keywords: "reporting" } }, select: { id: true } });
  await keepFound(search.id, "JSEARCH", found, { now: at });
  // When Positions first kept it.
  await prisma().posting.updateMany({ where: { externalId: { in: found.map((entry) => entry.externalId) } }, data: { createdAt: at } });
};
const inField = () => prisma().profile.update({ where: { id: TEST_PROFILE_ID }, data: { headline: "Regulatory Reporting Analyst" } });
/** A breakdown covering `hit` of `total` requirements. */
const breakdown = (hit: number, total: number) => ({ factors: [], cap: null, requirements: Array.from({ length: total }, (_, index) => ({ text: `R${index}`, mustHave: false, covered: index < hit, evidence: null })) });
const score = (id: string, hit: number, total: number) =>
  prisma().postingScore.create({ data: { source: "JSEARCH", externalId: id, profileId: TEST_PROFILE_ID, score: 50, reasons: [], redFlags: [], scoredWith: "test", breakdown: breakdown(hit, total) } });

/** An application made from a kept posting. */
const apply = async (externalId: string, status: "SENT" | "DRAFT") => {
  const application = await prisma().application.create({ data: { title: "Analyst", company: "Employer", role: "Analyst", status }, select: { id: true } });
  await prisma().posting.update({ where: { source_externalId: { source: "JSEARCH", externalId } }, data: { applicationId: application.id } });
};

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("which profile is in the field", () => {
  it("is none until a profile's own words say so, then each that does, in their order", async () => {
    expect(await fieldProfiles()).toEqual([]);
    expect(await hasFieldProfile()).toBe(false);
    await prisma().profile.create({ data: { id: "second", name: "Reporting", sort: 1, summary: "Four years of EMIR and MiFIR transaction reporting." } });
    expect(await fieldProfiles()).toEqual([{ id: "second", name: "Reporting" }]);
    await inField();
    expect((await fieldProfiles()).map((profile) => profile.id)).toEqual([TEST_PROFILE_ID, "second"]);
  });
});

describe("the Field filter in Positions", () => {
  it("lists only the postings her field's words mark: one in the title, or two in the text", async () => {
    await keep([
      posting("title", "Transaction Reporting Analyst"),
      posting("text", "Financial Analyst", { description: "You own the EMIR and MiFIR reports. The team works in English." }),
      posting("mention", "Accountant", { description: "Bank reconciliation every month." }),
      posting("other", "Product Designer"),
    ]);
    const ids = async (field: boolean) => (await listLibrary({ ...DEFAULT_FILTERS, sort: "new", ...(field ? { field } : {}) }, { now })).postings.map((entry) => entry.externalId).toSorted();
    expect(await ids(false)).toEqual(["mention", "other", "text", "title"]);
    expect(await ids(true)).toEqual(["text", "title"]);
  });
});

describe("loadFieldWeek", () => {
  it("is null while no profile is in the field", async () => {
    await keep([posting("a", "Regulatory Reporting Specialist")]);
    expect(await loadFieldWeek("Europe/Berlin", now)).toBeNull();
  });

  it("counts this week's marked postings, and those of them applied to, a Draft not counting", async () => {
    await inField();
    await keep([posting("sent", "Regulatory Reporting Specialist"), posting("draft", "Meldewesen Referent"), posting("open", "Reconciliation Analyst"), posting("other", "Product Designer")]);
    // Kept last week: not this week's.
    await keep([posting("old", "COREP Analyst")], new Date("2026-11-20T10:00:00.000Z"));
    await apply("sent", "SENT");
    await apply("draft", "DRAFT");
    expect(await loadFieldWeek("Europe/Berlin", now)).toEqual({ found: 3, applied: 1 });
  });
});

describe("loadFieldPicks (Today's three)", () => {
  it("is empty while no profile is in the field, or no slot is free", async () => {
    await keep([posting("a", "Regulatory Reporting Specialist")]);
    expect(await loadFieldPicks(3, now)).toEqual([]);
    await inField();
    expect(await loadFieldPicks(0, now)).toEqual([]);
    expect(await loadFieldPicks(3, now)).toHaveLength(1);
  });

  it("takes open marked postings with no application, the newest ad first, an ad with no date by when it was found", async () => {
    await inField();
    await keep([
      posting("older", "Regulatory Reporting Specialist", { postedAt: "2026-11-10T00:00:00.000Z" }),
      posting("newest", "Transaction Reporting Analyst", { postedAt: "2026-11-24T00:00:00.000Z" }),
      posting("undated", "Meldewesen Referent", { postedAt: null }),
      posting("stale", "COREP Analyst", { postedAt: "2026-09-01T00:00:00.000Z" }),
      posting("other", "Product Designer"),
    ]);
    const picks = await loadFieldPicks(5, now);
    expect(picks.map((pick) => pick.title)).toEqual(["Meldewesen Referent", "Transaction Reporting Analyst", "Regulatory Reporting Specialist", "COREP Analyst"]);
    expect(picks.map((pick) => pick.stale)).toEqual([true, false, false, true]);
    expect(picks[1]).toMatchObject({ company: "Employer newest", url: "https://jobs.example/newest", candidateId: null, jobId: null, coverage: { hit: 0, total: 0, mustMissing: 0 } });
    expect((await loadFieldPicks(2, now)).map((pick) => pick.title)).toEqual(["Meldewesen Referent", "Transaction Reporting Analyst"]);
  });

  it("leaves out one she applied to or dismissed, a scored low fit, and one that needs far more German than she has", async () => {
    await inField();
    await prisma().language.create({ data: { name: "German", level: "A2" } });
    await keep([
      posting("applied", "Regulatory Reporting Specialist"),
      posting("dismissed", "Transaction Reporting Analyst"),
      posting("low", "Meldewesen Referent"),
      posting("good", "COREP Analyst"),
      posting("german", "Reconciliation Analyst", { description: "Sie bringen verhandlungssichere Deutschkenntnisse (C1) mit." }),
      posting("unscored", "EMIR Analyst"),
    ]);
    await apply("applied", "DRAFT");
    await dismissPosting(posting("dismissed", "Transaction Reporting Analyst"));
    await score("low", 1, 5);
    await score("good", 3, 5);
    const picks = await loadFieldPicks(5, now);
    expect(picks.map((pick) => pick.title).toSorted()).toEqual(["COREP Analyst", "EMIR Analyst"]);
    expect(picks.find((pick) => pick.title === "COREP Analyst")?.coverage).toEqual({ hit: 3, total: 5, mustMissing: 0 });
  });
});
