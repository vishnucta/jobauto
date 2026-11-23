import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { archiveUntouched } from "@/lib/archive";
import { buildExport } from "@/lib/data-export";
import { importExport, parseExport } from "@/lib/data-import";
import { countLibrary, keepFound, listLibrary } from "@/lib/library";
import { keptApplication } from "@/lib/posting-application";
import { addClientSearch } from "@/lib/posting-searches";
import { dismissPosting, postingStates, savePosting } from "@/lib/postings";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../prisma/seed/built-ins";

import { withApplyOptions } from "./apply-options";
import { DEFAULT_FILTERS, EMPTY_QUERY, postingKey, type FoundPosting } from "./search";

// Every place a portal lists to apply at, kept with the posting (jobauto
// fork, "Keep every apply option"), against the test database: what's kept,
// that a kept posting's link and marks never change for it, and that every
// match by link a posting had before still holds. Made-up employers and links.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(32) } }));
const prisma = () => db.client!;

const now = new Date("2026-11-20T10:00:00.000Z");
const copy = { name: "Jooble", url: "https://de.jooble.org/jdp/7" };
const board = { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/7" };
const careers = { name: "Ledgerly Careers", url: "https://ledgerly.jobs.personio.de/job/7" };

/** A posting as JSearch finds it: with only the copy before this change, with every option after. */
const found = (id: string, extra: Partial<FoundPosting> = {}): FoundPosting => ({
  source: "JSEARCH",
  externalId: id,
  title: "Regulatory Reporting Analyst",
  company: "Ledgerly GmbH",
  place: "Hamburg",
  remote: null,
  salary: "",
  postedAt: "2026-11-18T00:00:00.000Z",
  url: copy.url,
  via: "Jooble",
  description: "Ledgerly is hiring an analyst for its reporting team.",
  complete: true,
  ...extra,
});
const withOptions = (id: string, extra: Partial<FoundPosting> = {}) => withApplyOptions(found(id, extra), [copy, board, careers]);
const keep = async (postings: FoundPosting[], at = now, portal = "JSEARCH") => {
  const search = await prisma().postingSearch.create({ data: { query: { keywords: "reporting" } }, select: { id: true } });
  await keepFound(search.id, portal, postings, { now: at });
};
const row = (externalId: string, source = "JSEARCH") => prisma().posting.findUniqueOrThrow({ where: { source_externalId: { source, externalId } } });

beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
});
afterAll(() => prisma().$disconnect());

describe("what a found posting keeps", () => {
  it("keeps the employer's own link and every place it's listed at, and Positions reads them back", async () => {
    await keep([withOptions("p1")]);
    expect(await row("p1")).toMatchObject({ url: careers.url, applyOptions: [copy, board, careers] });
    const [shown] = (await listLibrary(DEFAULT_FILTERS, { now })).postings;
    expect(shown).toMatchObject({ url: careers.url, applyOptions: [copy, board, careers] });
  });

  it("stores nothing for a posting from a portal that lists one place", async () => {
    await keep([found("p1")]);
    expect((await row("p1")).applyOptions).toBeNull();
    expect((await listLibrary(DEFAULT_FILTERS, { now })).postings[0]).not.toHaveProperty("applyOptions");
  });
});

describe("a posting kept before, found again with a better link", () => {
  it("keeps its link and how she left it: saved, seen, not new; the places found now are added", async () => {
    await keep([found("saved"), found("seen", { externalId: "seen", title: "COREP Analyst" })]);
    await savePosting(found("saved"));
    await prisma().posting.update({ where: { source_externalId: { source: "JSEARCH", externalId: "seen" } }, data: { seenAt: now } });
    const before = await countLibrary();

    await keep([withOptions("saved"), withOptions("seen", { title: "COREP Analyst" })], new Date("2026-11-21T10:00:00.000Z"));
    const saved = await row("saved");
    expect(saved).toMatchObject({ url: copy.url, applyOptions: [copy, board, careers] });
    expect(saved.savedAt).not.toBeNull();
    expect(await row("seen")).toMatchObject({ url: copy.url, seenAt: now });
    expect(await countLibrary()).toEqual(before);
  });

  it("leaves a dismissed posting and one in the Archive as they are", async () => {
    await keep([found("dismissed"), found("archived", { title: "COREP Analyst" })]);
    await dismissPosting(found("dismissed"));
    await prisma().posting.update({ where: { source_externalId: { source: "JSEARCH", externalId: "archived" } }, data: { archivedAt: now } });

    await keep([withOptions("dismissed"), withOptions("archived", { title: "COREP Analyst" })], new Date("2026-11-21T10:00:00.000Z"));
    expect(await row("dismissed")).toMatchObject({ url: copy.url, applyOptions: null });
    expect((await row("dismissed")).dismissedAt).not.toBeNull();
    const archived = await row("archived");
    expect(archived).toMatchObject({ url: copy.url });
    expect(archived.archivedAt).not.toBeNull();
    const states = await postingStates([found("dismissed"), found("archived")]);
    expect(states.get(postingKey(found("dismissed")))).toMatchObject({ dismissed: true, new: false });
    expect(states.get(postingKey(found("archived")))).toMatchObject({ archived: true });
  });
});

describe("every match by link a posting had", () => {
  it("counts an application made from the copy's link as applied for, when the search now leads with the employer's", async () => {
    const application = await prisma().application.create({ data: { title: "Analyst", company: "Ledgerly", role: "Analyst", status: "SENT", postingUrl: copy.url }, select: { id: true } });
    const now7 = withOptions("p7");
    expect(now7.url).toBe(careers.url);
    expect((await postingStates([now7])).get(postingKey(now7))).toMatchObject({ applicationId: application.id, draft: false });
    // A posting found before kept the copy's link: matched as before.
    expect((await postingStates([found("p7")])).get(postingKey(found("p7")))?.applicationId).toBe(application.id);
    // Kept, and Prepare it for me asks: the same application, by the link it's listed at.
    await keep([now7]);
    expect(await keptApplication({ source: "JSEARCH", externalId: "p7", url: careers.url })).toBe(application.id);
  });

  it("merges the same job from another portal that leads with a link this one is listed at", async () => {
    await keep([withOptions("j1")]);
    await keep([{ ...found("a1"), source: "ADZUNA" }], now, "ADZUNA");
    const kept = await row("j1");
    expect((await row("a1", "ADZUNA")).mergedIntoId).toBe(kept.id);
  });

  it("leaves out of add_found_jobs a job known by a link the kept posting no longer leads with", async () => {
    await keep([withOptions("j1")]);
    const { added, skipped } = await addClientSearch({
      addedBy: "Claude",
      query: { ...EMPTY_QUERY, keywords: "reporting" },
      // Another title, so only the link can tell.
      postings: [{ ...found("c1", { title: "Reporting Specialist" }), source: "CLIENT" }],
    });
    expect(added).toEqual([]);
    expect(skipped[0].known).toMatchObject({ where: "search" });
  });

  it("doesn't move a posting to the Archive while an application was made from one of its links", async () => {
    await keep([withOptions("applied"), withOptions("untouched", { title: "COREP Analyst" })], new Date("2026-09-01T10:00:00.000Z"));
    await prisma().application.create({ data: { title: "Analyst", company: "Ledgerly", role: "Analyst", postingUrl: copy.url } });
    // Each has the copy among its places, so give the second one a copy of its own.
    await prisma().posting.update({ where: { source_externalId: { source: "JSEARCH", externalId: "untouched" } }, data: { applyOptions: [careers] } });
    await archiveUntouched({ now, days: 30 });
    expect((await row("applied")).archivedAt).toBeNull();
    expect((await row("untouched")).archivedAt).not.toBeNull();
  });
});

describe("the data export", () => {
  it("has each posting's places to apply at, and an import puts them back; a file from before has none", async () => {
    await keep([withOptions("p1"), found("p2", { title: "COREP Analyst" })]);
    const file = await buildExport(prisma(), { now });
    expect(file.postings.find((posting) => posting.externalId === "p1")?.applyOptions).toEqual([copy, board, careers]);
    const parsed = parseExport(JSON.stringify(file));
    if (!parsed.ok) throw new Error(parsed.error);
    await importExport(prisma(), parsed.data);
    expect((await row("p1")).applyOptions).toEqual([copy, board, careers]);
    expect((await row("p2")).applyOptions).toBeNull();

    // As a file from before this change has it: no applyOptions at all.
    const older = JSON.parse(JSON.stringify(file)) as { postings: Record<string, unknown>[] };
    for (const posting of older.postings) delete posting.applyOptions;
    const before = parseExport(JSON.stringify(older));
    if (!before.ok) throw new Error(before.error);
    await importExport(prisma(), before.data);
    expect(await row("p1")).toMatchObject({ url: careers.url, applyOptions: null });
  });
});
