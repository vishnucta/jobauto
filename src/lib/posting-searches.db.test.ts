import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";
import { clearJobSearchCache } from "@/lib/job-search/cache";
import { fullText } from "@/lib/job-search/find";
import { EMPTY_QUERY } from "@/lib/job-search/search";
import { savePosting } from "@/lib/postings";
import { encryptSecret, JOB_SOURCE_KEY } from "@/lib/secrets";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";
import { joobleResponse, jsearchV2LastPage, jsearchV2Page, serpapiLastPage, serpapiPage } from "@/test/job-search-fixtures";

import { removeRecruiter } from "@/lib/recruiters/store";

import { addClientSearch, countSearches, listSearches, loadSearch, removeSearch, runSearch, showMoreFor } from "./posting-searches";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
const prisma = () => db.client!;

const query = { ...EMPTY_QUERY, keywords: "product designer", place: "Hamburg", country: "de" };
const useJSearch = () => saveSettings({ jobSource: "JSEARCH", jsearchKeyEnc: encryptSecret(JOB_SOURCE_KEY, "ak_test") });

beforeEach(async () => {
  await resetDatabase(prisma());
  clearJobSearchCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => prisma().$disconnect());

describe("runSearch", () => {
  it("is off until a source is chosen, and needs a country and a key", async () => {
    expect(await runSearch(query)).toEqual({ ok: false, problem: "off", message: "Choose where to search in Settings → Job search first." });
    await saveSettings({ jobSource: "JSEARCH" });
    expect(await runSearch({ ...query, country: "" })).toMatchObject({ ok: false, problem: "no-country" });
    expect(await runSearch(query)).toEqual({ ok: false, problem: "no-key", message: "Add your JSearch key in Settings → Job search first." });
    expect(await countSearches()).toBe(0);
  });

  it("keeps the search with its first page", async () => {
    await useJSearch();
    const requests = stubFetch(() => json(jsearchV2Page));
    const result = await runSearch(query);
    expect(result).toEqual({ ok: true, id: expect.any(String), problems: [] });
    expect(requests[0].headers.get("x-api-key")).toBe("ak_test");
    const kept = await prisma().postingSearch.findUniqueOrThrow({ where: { id: result.ok ? result.id : "" } });
    expect(kept).toMatchObject({ sources: ["JSEARCH"], query, found: 2, cursors: { JSEARCH: "cursor:CURSOR-PAGE-2" }, problems: [] });
  });

  it("keeps nothing when the source says no", async () => {
    await useJSearch();
    stubFetch(() => json({}, { status: 429 }));
    expect(await runSearch(query)).toMatchObject({ ok: false, problem: "quota" });
    expect(await countSearches()).toBe(0);
  });

  it("treats a request that fails as the source not answering", async () => {
    await useJSearch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("boom");
    });
    expect(await runSearch(query)).toMatchObject({ ok: false, problem: "unavailable" });
  });
});

describe("loadSearch", () => {
  it("opens a kept search without asking the source, with where each posting stands now", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    const requests = stubFetch(() => json(jsearchV2Page));

    const now = new Date();
    const search = await loadSearch(run.ok ? run.id : "", { now });
    expect(requests).toHaveLength(0);
    expect(search).toMatchObject({ sources: ["JSEARCH"], query, more: true, problems: [], ranAt: expect.stringMatching(/^today at \d\d:\d\d$/) });
    expect(search!.postings.map((posting) => [posting.title, posting.state.saved])).toEqual([
      ["Senior Product Designer, Payments", false],
      ["UX Researcher", false],
    ]);

    const { state, ...ledgerly } = search!.postings[0];
    void state;
    await savePosting(ledgerly);
    expect((await loadSearch(search!.id))!.postings[0].state.saved).toBe(true);
  });

  it("opens the latest search without an id, and nothing when there's none or it's gone", async () => {
    expect(await loadSearch()).toBeNull();
    await prisma().postingSearch.create({ data: { sources: ["JSEARCH"], query, postings: [], createdAt: new Date("2026-10-01T10:00:00Z") } });
    const latest = await prisma().postingSearch.create({ data: { sources: ["JSEARCH"], query: { ...query, keywords: "researcher" }, postings: [] } });
    expect((await loadSearch())?.id).toBe(latest.id);
    expect(await loadSearch("gone")).toBeNull();
  });

  it("reads past an old posting that no longer fits, and a damaged search", async () => {
    const search = await prisma().postingSearch.create({
      data: { sources: ["ADZUNA"], query: { keywords: 1 }, postings: [{ title: "No id" }, ...jsearchV2LastPage.data.jobs.map(() => ({ ...EMPTY_POSTING }))] },
      select: { id: true },
    });
    expect(await loadSearch(search.id, { now: new Date() })).toMatchObject({ query: EMPTY_QUERY, postings: [expect.objectContaining({ externalId: "kept" })] });
    await prisma().postingSearch.update({ where: { id: search.id }, data: { postings: { not: "a list" } } });
    expect((await loadSearch(search.id))!.postings).toEqual([]);
  });

  it("says when it ran: yesterday, or the day", async () => {
    const yesterday = await prisma().postingSearch.create({ data: { sources: ["JSEARCH"], query, postings: [], createdAt: new Date("2026-10-02T16:20:00Z") } });
    const older = await prisma().postingSearch.create({ data: { sources: ["JSEARCH"], query, postings: [], createdAt: new Date("2026-09-28T08:05:00Z") } });
    const now = new Date("2026-10-03T12:00:00Z");
    expect((await loadSearch(yesterday.id, { timeZone: "Europe/Berlin", now }))!.ranAt).toBe("yesterday at 18:20");
    expect((await loadSearch(older.id, { timeZone: "Europe/Berlin", now }))!.ranAt).toBe("on Mon 28 Sep at 10:05");
  });
});

const EMPTY_POSTING = {
  source: "JSEARCH",
  externalId: "kept",
  title: "Kept",
  company: "",
  place: "",
  remote: null,
  salary: "",
  postedAt: null,
  url: "",
  via: "",
  description: "",
  complete: false,
};

describe("showMoreFor", () => {
  it("adds the next page to the kept search, once each, from the search's own source", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    const id = run.ok ? run.id : "";
    // The user switched sources meanwhile: the search goes on with its own.
    await saveSettings({ jobSource: "ARBEITSAGENTUR" });

    const requests = stubFetch(() => json(jsearchV2LastPage));
    const more = await showMoreFor(id);
    expect(requests[0].url.searchParams.get("cursor")).toBe("CURSOR-PAGE-2");
    // UX Researcher was on the first page already.
    expect(more).toEqual({ ok: true, postings: [], more: false, problems: [] });
    expect(await prisma().postingSearch.findUniqueOrThrow({ where: { id } })).toMatchObject({ found: 2, cursors: {} });

    // The last page: nothing more to ask.
    expect(await showMoreFor(id)).toEqual({ ok: true, postings: [], more: false, problems: [] });
    expect(requests).toHaveLength(1);
  });

  it("adds new postings with where they stand", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2LastPage));
    const run = await runSearch({ ...query, keywords: "researcher" });
    const id = run.ok ? run.id : "";
    await prisma().postingSearch.update({ where: { id }, data: { cursors: { JSEARCH: "cursor:MORE" } } });
    stubFetch(() => json(jsearchV2Page));
    const more = await showMoreFor(id);
    expect(more).toMatchObject({ ok: true, more: true, postings: [expect.objectContaining({ title: "Senior Product Designer, Payments", state: expect.objectContaining({ saved: false }) })] });
    expect((await prisma().postingSearch.findUniqueOrThrow({ where: { id } })).found).toBe(2);
  });

  it("says when the search is gone, or the source says no", async () => {
    expect(await showMoreFor("gone")).toMatchObject({ ok: false, message: "That search is no longer kept. Search again." });
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    stubFetch(() => json({}, { status: 429 }));
    expect(await showMoreFor(run.ok ? run.id : "")).toMatchObject({ ok: false, problem: "quota" });
  });
});

describe("listSearches and removeSearch", () => {
  it("lists kept searches newest first, grouped by the day they ran in the user's time zone", async () => {
    const at = (iso: string, keywords: string) =>
      prisma().postingSearch.create({ data: { sources: ["JSEARCH"], query: { ...query, keywords }, postings: [], found: 3, createdAt: new Date(iso) } });
    await at("2026-10-03T09:30:00Z", "designer");
    await at("2026-10-02T22:30:00Z", "researcher"); // Already the 3rd in Berlin.
    await at("2026-10-02T10:00:00Z", "writer");
    await at("2026-09-28T08:00:00Z", "nurse");

    const days = await listSearches({ timeZone: "Europe/Berlin", now: new Date("2026-10-03T12:00:00Z") });
    expect(days.map((day) => [day.day, day.searches.map((search) => [search.time, search.query.keywords, search.found])])).toEqual([
      ["Today", [["11:30", "designer", 3], ["00:30", "researcher", 3]]],
      ["Yesterday", [["12:00", "writer", 3]]],
      ["Mon 28 Sep", [["10:00", "nurse", 3]]],
    ]);
    expect(await countSearches()).toBe(4);
  });

  it("removes a search, and leaves saved postings alone", async () => {
    const search = await prisma().postingSearch.create({ data: { sources: ["JSEARCH"], query, postings: [EMPTY_POSTING] } });
    await savePosting({ ...EMPTY_POSTING, source: "JSEARCH" });
    await removeSearch(search.id);
    await removeSearch("gone");
    expect(await countSearches()).toBe(0);
    expect(await prisma().posting.count()).toBe(1);
  });
});

describe("fullText", () => {
  it("returns a complete posting's own text, and asks the posting's own source for the rest", async () => {
    await useJSearch();
    stubFetch(() => json(jsearchV2Page));
    const run = await runSearch(query);
    const { state, ...posting } = (await loadSearch(run.ok ? run.id : ""))!.postings[0];
    void state;
    expect(await fullText(posting)).toBe(posting.description);
    expect(await fullText({ ...posting, complete: false })).toBe(posting.description);
  });

  it("gives up quietly without the source's key", async () => {
    expect(await fullText({ ...EMPTY_POSTING, source: "JSEARCH", complete: false })).toBeNull();
  });
});

describe("searches on several sources", () => {
  const useSerpApiToo = () => saveSettings({ serpapiKeyEnc: encryptSecret(JOB_SOURCE_KEY, "serp_test") });
  /** Answers JSearch and SerpApi each in their own way; a source without an answer fails. */
  const bySource = (answers: { jsearch?: () => Response; serpapi?: () => Response }) =>
    stubFetch(({ url }) => (url.hostname === "serpapi.com" ? answers.serpapi?.() : answers.jsearch?.()) ?? json({}, { status: 500 }));

  it("asks them together and lists the same job once, noting where else it was found", async () => {
    await useJSearch();
    await useSerpApiToo();
    const requests = bySource({ jsearch: () => json(jsearchV2Page), serpapi: () => json(serpapiPage) });
    const run = await runSearch(query, ["JSEARCH", "SERPAPI"]);
    expect(run).toEqual({ ok: true, id: expect.any(String), problems: [] });
    expect(requests.map((request) => request.url.hostname).sort()).toEqual(["api.openwebninja.com", "serpapi.com"]);
    const kept = await loadSearch(run.ok ? run.id : "");
    expect(kept).toMatchObject({ sources: ["JSEARCH", "SERPAPI"], more: true, problems: [] });
    expect(kept!.postings.map((posting) => [posting.title, posting.source, posting.alsoOn])).toEqual([
      ["Senior Product Designer, Payments", "JSEARCH", ["SERPAPI"]],
      ["UX Researcher", "JSEARCH", ["SERPAPI"]],
    ]);
    expect(await prisma().postingSearch.findUniqueOrThrow({ where: { id: kept!.id } })).toMatchObject({ cursors: { JSEARCH: "cursor:CURSOR-PAGE-2", SERPAPI: "TOKEN-PAGE-2" } });

    // Show more asks each source for its next page, and leaves out what the search already holds.
    const more = bySource({ jsearch: () => json(jsearchV2LastPage), serpapi: () => json(serpapiLastPage) });
    expect(await showMoreFor(kept!.id)).toEqual({ ok: true, postings: [], more: false, problems: [] });
    expect(more.map((request) => request.url.searchParams.get("cursor") ?? request.url.searchParams.get("next_page_token")).sort()).toEqual(["CURSOR-PAGE-2", "TOKEN-PAGE-2"]);
  });

  it("searches Jooble beside another source, keeping its page position for Show more", async () => {
    await useJSearch();
    await saveSettings({ joobleKeyEnc: encryptSecret(JOB_SOURCE_KEY, "jooble_test") });
    const requests = stubFetch(({ url }) => (url.hostname === "jooble.org" ? json(joobleResponse) : json(jsearchV2Page)));
    const run = await runSearch(query, ["JSEARCH", "JOOBLE"]);
    expect(run).toEqual({ ok: true, id: expect.any(String), problems: [] });
    const jooble = requests.find((request) => request.url.hostname === "jooble.org");
    expect(jooble).toMatchObject({ method: "POST" });
    expect(jooble!.url.pathname).toBe("/api/jooble_test");
    const kept = await loadSearch(run.ok ? run.id : "");
    expect(kept).toMatchObject({ sources: ["JSEARCH", "JOOBLE"], more: true });
    expect(kept!.postings.some((posting) => posting.source === "JOOBLE" && posting.title === "Meldewesen Spezialist")).toBe(true);
    expect(await prisma().postingSearch.findUniqueOrThrow({ where: { id: kept!.id } })).toMatchObject({ cursors: { JOOBLE: "page:2:4" } });

    // Show more asks Jooble for the page after, by number.
    const more = stubFetch(({ url }) => (url.hostname === "jooble.org" ? json({ totalCount: 45, jobs: [] }) : json(jsearchV2LastPage)));
    await showMoreFor(kept!.id);
    expect(more.find((request) => request.url.hostname === "jooble.org")!.body).toMatchObject({ page: "2" });
  });

  it("goes on without a source that can't answer, with a ready one standing in, and says so", async () => {
    await useJSearch();
    await useSerpApiToo();
    bySource({ jsearch: () => json({}, { status: 429 }), serpapi: () => json(serpapiPage) });
    const run = await runSearch(query, ["JSEARCH"]);
    expect(run).toMatchObject({ ok: true, problems: [{ source: "JSEARCH", problem: "quota", fallback: "SERPAPI" }] });
    expect(await loadSearch(run.ok ? run.id : "")).toMatchObject({
      sources: ["SERPAPI"],
      problems: [{ source: "JSEARCH", problem: "quota", message: expect.stringContaining("used up your JSearch searches"), fallback: "SERPAPI" }],
    });
  });

  it("says so when a chosen source has no key: beside the others' results, or as the whole answer when no source is ready", async () => {
    await useJSearch();
    bySource({ jsearch: () => json(jsearchV2Page) });
    const beside = await runSearch(query, ["JSEARCH", "SERPAPI"]);
    expect(beside).toMatchObject({ ok: true, problems: [{ source: "SERPAPI", problem: "no-key", message: "Add your SerpApi key in Settings → Job search first." }] });
    expect((await loadSearch(beside.ok ? beside.id : ""))!.sources).toEqual(["JSEARCH"]);
    // Asked alone, the ready source stands in.
    expect(await runSearch({ ...query, keywords: "other" }, ["SERPAPI"])).toMatchObject({ ok: true, problems: [{ source: "SERPAPI", problem: "no-key", fallback: "JSEARCH" }] });

    await saveSettings({ jsearchKeyEnc: null });
    expect(await runSearch(query, ["SERPAPI"])).toEqual({ ok: false, problem: "no-key", message: "Add your SerpApi key in Settings → Job search first." });
  });
});

describe("agencies in what a search finds", () => {
  const fromAgency = (company: string, id = "sj-1") => ({ ...jsearchV2LastPage, data: { jobs: [{ job_id: id, job_title: "Regulatory Reporting Specialist", employer_name: company, job_publisher: "LinkedIn" }], cursor: null } });

  it("go on the Recruiters list, with the role they posted, and an employer doesn't", async () => {
    await useJSearch();
    stubFetch(() => json(fromAgency("Selby Jennings")));
    await runSearch(query);
    stubFetch(() => json(fromAgency("Fielmann AG", "f-1")));
    await runSearch({ ...query, keywords: "analyst" });
    expect(await prisma().recruiter.findMany({ select: { name: true, source: true, events: { select: { text: true }, orderBy: { at: "asc" } } } })).toEqual([
      { name: "Selby Jennings", source: "found in search", events: [{ text: "Found in a search" }, { text: "Posted: Regulatory Reporting Specialist" }] },
    ]);
  });

  it("come from the next page, and from jobs an AI client adds", async () => {
    await useJSearch();
    stubFetch(() => json({ ...jsearchV2Page, data: { ...jsearchV2Page.data, cursor: "MORE" } }));
    const run = await runSearch(query);
    stubFetch(() => json(fromAgency("Robert Walters", "rw-1")));
    await showMoreFor(run.ok ? run.id : "");
    await addClientSearch({
      addedBy: "Gemini CLI",
      query,
      postings: [{ ...EMPTY_POSTING, source: "CLIENT", externalId: "h-1", title: "Financial Analyst", company: "Hays", url: "https://www.hays.de/jobs/1" }],
    });
    expect((await prisma().recruiter.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((entry) => entry.name)).toEqual(["Hays", "Robert Walters"]);
  });

  it("stay off once the user removed them", async () => {
    await useJSearch();
    stubFetch(() => json(fromAgency("Hays")));
    await runSearch(query);
    const { id } = await prisma().recruiter.findFirstOrThrow();
    await removeRecruiter(id);
    stubFetch(() => json(fromAgency("Hays", "sj-2")));
    await runSearch({ ...query, keywords: "other" });
    expect(await prisma().recruiter.count()).toBe(0);
  });
});
