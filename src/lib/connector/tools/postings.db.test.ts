import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { startJob } from "@/lib/jobs/runner";
import { saveScore } from "@/lib/posting-scores";
import { dismissPosting, savePosting } from "@/lib/postings";
import { loadProfile } from "@/lib/profile-data";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// Find jobs' tools (jobauto fork), called as Claude calls them, through
// /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const fake = vi.hoisted(() => ({ aiUsable: true }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => fake.aiUsable, isAiConfigured: async () => fake.aiUsable }));
vi.mock("@/lib/job-search/find", () => ({
  fullText: vi.fn(async () => null),
  askSource: vi.fn(async () => ({ ok: false, problem: "off", message: "No job source here." })),
}));
// Nothing is scored here: the job only starts.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "score-job"),
}));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

function found(id: string, title: string) {
  return {
    source: "JSEARCH" as const,
    externalId: id,
    title,
    company: "Acme",
    place: "Berlin",
    remote: null,
    salary: "",
    postedAt: null,
    url: `https://jobs.example/${id}`,
    via: "",
    description: `${title}: Figma, design systems.`,
    complete: true,
  };
}

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  fake.aiUsable = true;
  vi.mocked(startJob).mockClear();
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
});
afterAll(() => prisma().$disconnect());

/** Sends one request to /api/mcp as Claude does; its result. */
async function rpc(method: string, params: Record<string, unknown>) {
  const response = await POST(
    new Request("https://dossier.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await response.text();
  return JSON.parse(body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result;
}

/** Calls a tool; its text answer, parsed when it's JSON, and whether it's an error. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> & unknown[] }> {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> & unknown[] };
}

const storeSearch = (postings: unknown[], createdAt?: Date) =>
  prisma().postingSearch.create({
    data: {
      sources: ["JSEARCH"],
      query: { keywords: "designer", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
      postings: postings as object[],
      found: postings.length,
      cursors: { JSEARCH: "page:2" },
      createdAt,
    },
  });

describe("Find jobs through the Claude connector", () => {
  it("offers its tools, with hints that say what they change", async () => {
    const { tools } = (await rpc("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations]));
    expect(hints.list_postings).toEqual({ readOnlyHint: true });
    // Unsave and restore delete a posting nothing else keeps.
    expect(hints.update_postings).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(hints.remove_search).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(hints.score_with_dossier).toEqual({ readOnlyHint: false, openWorldHint: true });
  });

  it("lists saved and dismissed postings and past searches, with the ids the other tools take", async () => {
    const search = await storeSearch([found("p1", "Product Designer"), found("p2", "Brand Designer"), found("p3", "UX Writer")]);
    const saved = await savePosting(found("p1", "Product Designer"));
    await saveScore(found("p1", "Product Designer"), { score: 88, reasons: ["Led a design system"], redFlags: [] }, "test");
    await dismissPosting(found("p2", "Brand Designer"));

    expect((await tool("list_postings")).json).toMatchObject({
      saved: { total: 1, postings: [{ posting_id: saved.id, title: "Product Designer", saved: true, fit: { score: 88 } }], link: "https://dossier.example/jobs?view=saved" },
      dismissed: { total: 1, postings: [{ title: "Brand Designer" }], link: "https://dossier.example/jobs?view=dismissed" },
      searches: {
        total: 1,
        searches: [{ search_id: search.id, searched: "designer · Berlin, 25 km", ran: expect.stringMatching(/^Today at \d\d:\d\d$/), found: 3, source: "JSearch" }],
        link: "https://dossier.example/jobs?view=history",
      },
    });
    expect(Object.keys((await tool("list_postings", { view: "searches" })).json)).toEqual(["searches"]);
    expect((await tool("list_postings", { view: "saved", limit: 1 })).json).toMatchObject({ saved: { total: 1 } });

    const opened = await tool("list_postings", { search_id: search.id, from: 2, limit: 1 });
    expect(opened.json).toMatchObject({
      search_id: search.id,
      searched: "designer · Berlin, 25 km",
      found: 3,
      more_available: true,
      postings: [{ number: 2, title: "Brand Designer", dismissed: true }],
      link: `https://dossier.example/jobs?search=${search.id}`,
    });
    expect(opened.json.postings).toHaveLength(1);
    expect(await tool("list_postings", { search_id: "gone" })).toMatchObject({ isError: true, text: "That search is no longer kept. Search again." });
  });

  it("pages through every list with from and limit, since the views show them all", async () => {
    const day = (date: number) => new Date(`2026-10-${date}T09:00:00Z`);
    const searches = await Promise.all([20, 21, 22].map((date) => storeSearch([found(`s${date}`, "Designer")], day(date))));
    for (const [index, date] of [20, 21, 22].entries()) {
      await savePosting(found(`p${index}`, `Saved ${index + 1}`));
      await dismissPosting(found(`d${index}`, `Dismissed ${index + 1}`));
      await prisma().posting.updateMany({ where: { externalId: `p${index}` }, data: { savedAt: day(date) } });
      await prisma().posting.updateMany({ where: { externalId: `d${index}` }, data: { dismissedAt: day(date) } });
    }

    // Newest first, as on the screens: the second of each list.
    expect((await tool("list_postings", { from: 2, limit: 1 })).json).toMatchObject({
      saved: { total: 3, postings: [{ title: "Saved 2" }] },
      dismissed: { total: 3, postings: [{ title: "Dismissed 2" }] },
      searches: { total: 3, searches: [{ search_id: searches[1].id }] },
    });
    expect((await tool("list_postings", { view: "dismissed", from: 3 })).json).toMatchObject({ dismissed: { total: 3, postings: [{ posting_id: expect.any(String), title: "Dismissed 1" }] } });
    expect((await tool("list_postings", { view: "saved", from: 4 })).json).toMatchObject({ saved: { total: 3, postings: [] } });
  });

  it("saves, dismisses and brings back postings, from a search by number or by posting_id", async () => {
    const search = await storeSearch([found("p1", "Product Designer"), found("p2", "Brand Designer")]);
    const first = await tool("update_postings", {
      search_id: search.id,
      changes: [
        { action: "save", number: 1 },
        { action: "dismiss", number: 2 },
        { action: "save", number: 9 },
      ],
    });
    expect(first.json).toMatchObject({
      updated: [
        { number: 1, posting_id: expect.any(String), title: "Product Designer", saved: true, dismissed: false },
        { number: 2, posting_id: expect.any(String), title: "Brand Designer", saved: false, dismissed: true },
      ],
      not_found: [9],
      link: `https://dossier.example/jobs?search=${search.id}`,
    });
    const [designer, brand] = first.json.updated as { posting_id: string }[];

    // Dismissing takes it out of Saved; one brought back that nothing else keeps is no longer stored.
    const second = await tool("update_postings", {
      changes: [
        { action: "dismiss", posting_id: designer.posting_id },
        { action: "restore", posting_id: brand.posting_id },
      ],
    });
    expect(second.json).toMatchObject({ updated: [{ posting_id: designer.posting_id, saved: false, dismissed: true }, { title: "Brand Designer", saved: false, dismissed: false }], link: "https://dossier.example/jobs?view=saved" });
    expect(await prisma().posting.findUnique({ where: { id: brand.posting_id } })).toBeNull();
    expect((await tool("update_postings", { changes: [{ action: "dismiss", posting_id: designer.posting_id }] })).json).toMatchObject({ link: "https://dossier.example/jobs?view=dismissed" });

    // Each one is found before any change, so bringing back and saving the same posting works in one go.
    const third = await tool("update_postings", {
      changes: [
        { action: "restore", posting_id: designer.posting_id },
        { action: "save", posting_id: designer.posting_id },
      ],
    });
    expect(third.json).toMatchObject({ updated: [{ saved: true, dismissed: false }, { saved: true, dismissed: false }] });
    const again = (third.json.updated as { posting_id: string }[])[1].posting_id;
    expect((await tool("update_postings", { changes: [{ action: "unsave", posting_id: again }] })).json).toMatchObject({ updated: [{ title: "Product Designer", saved: false, dismissed: false }] });
    expect(await prisma().posting.count()).toBe(0);

    expect(await tool("update_postings", { changes: [{ action: "save", posting_id: "gone" }] })).toMatchObject({
      isError: true,
      text: "None of those postings could be found. Use numbers from the search, or posting_id values from list_postings.",
    });
    expect(await tool("update_postings", { search_id: "gone", changes: [{ action: "save", number: 1 }] })).toMatchObject({ isError: true, text: "That search is no longer kept. Search again." });
  });

  it("keeps jobs an AI client found itself as a search of their own, named by the client, and leaves out what Dossier already has", async () => {
    const job = (title: string, url: string) => ({ title, company: "Acme", place: "Hamburg", url, description: `${title}: Excel, reporting.`, found_on: "LinkedIn", posted: "2026-10-28" });
    const jsearch = await storeSearch([found("p1", "Product Designer")], new Date("2026-10-20T09:00:00Z"));
    const added = await tool("add_found_jobs", {
      client: "Gemini CLI",
      searched: { keywords: "financial analyst", place: "Hamburg", country: "de" },
      // The same page twice, once with a tracking parameter, is one posting.
      jobs: [job("Financial Analyst", "https://jobs.example/fa?utm_source=x"), job("Junior Analyst", "https://jobs.example/ja"), job("Financial Analyst again", "https://jobs.example/fa")],
    });
    expect(added.isError).toBe(false);
    const searchId = added.json.search_id as string;
    expect(added.json).toMatchObject({
      searched: "financial analyst · Hamburg, 25 km",
      source: "AI client · Gemini CLI",
      added: 2,
      postings: [
        { number: 1, title: "Financial Analyst", company: "Acme", place: "Hamburg", posted: "2026-10-28", via: "LinkedIn", url: "https://jobs.example/fa?utm_source=x" },
        { number: 2, title: "Junior Analyst" },
      ],
      skipped: [{ title: "Financial Analyst again", reason: "twice in this list" }],
      link: `https://dossier.example/jobs?search=${searchId}`,
    });

    // Listed with the job source's searches, saying who added it, and saved or dismissed like any other.
    expect((await tool("list_postings", { view: "searches" })).json).toMatchObject({
      searches: { total: 2, searches: [{ search_id: searchId, source: "AI client · Gemini CLI", found: 2 }, { search_id: jsearch.id, source: "JSearch" }] },
    });
    expect((await tool("update_postings", { search_id: searchId, changes: [{ action: "save", number: 1 }, { action: "dismiss", number: 2 }] })).json).toMatchObject({
      updated: [
        { number: 1, saved: true },
        { number: 2, dismissed: true },
      ],
    });
    expect(await prisma().posting.findMany({ where: { source: "CLIENT" }, select: { title: true }, orderBy: { title: "asc" } })).toEqual([{ title: "Financial Analyst" }, { title: "Junior Analyst" }]);

    // Narrowed to one source, as the From filter on Find jobs does.
    expect((await tool("list_postings", { view: "saved", source: "client" })).json).toMatchObject({
      saved: { total: 1, postings: [{ title: "Financial Analyst" }], link: "https://dossier.example/jobs?view=saved&from=client" },
    });
    expect((await tool("list_postings", { view: "searches", source: "jsearch" })).json).toMatchObject({
      searches: { total: 1, searches: [{ search_id: jsearch.id }], link: "https://dossier.example/jobs?view=history&from=jsearch" },
    });

    // Nothing is added twice: what a job source found (by link, or the same opening on another site), what's saved or dismissed, stay out, each with where it is.
    const again = await tool("add_found_jobs", {
      searched: { keywords: "analyst" },
      jobs: [
        job("Junior Analyst", "https://jobs.example/ja"),
        { title: "Product Designer", company: "Acme", place: "Berlin", url: "https://jobs.example/p1?ref=mail" },
        { title: "Product Designer (m/w/d)", company: "Acme", place: "Berlin, Germany", url: "https://other.example/pd" },
        job("Financial Analyst", "https://jobs.example/fa"),
        job("Data Analyst", "https://jobs.example/da"),
      ],
    });
    expect(again.json).toMatchObject({
      source: "AI client · Claude",
      searched: "analyst",
      added: 1,
      postings: [{ number: 1, title: "Data Analyst" }],
      skipped: [
        { title: "Junior Analyst", reason: "dismissed before", posting_id: expect.any(String) },
        { title: "Product Designer", reason: "already found by JSearch", search_id: jsearch.id, number: 1 },
        { title: "Product Designer (m/w/d)", reason: "already found by JSearch", search_id: jsearch.id, number: 1 },
        { title: "Financial Analyst", reason: "already saved", posting_id: expect.any(String) },
      ],
    });

    // Every one known: nothing is added and no search is kept. add_known adds them anyway, for openings the user says differ.
    const none = await tool("add_found_jobs", { searched: { keywords: "analyst" }, jobs: [job("Data Analyst", "https://jobs.example/da")] });
    expect(none.isError).toBe(false);
    expect(none.json).toMatchObject({ added: 0, skipped: [{ title: "Data Analyst", reason: "already added by Claude", search_id: again.json.search_id, number: 1 }] });
    expect(none.json.search_id).toBeUndefined();
    expect((await tool("add_found_jobs", { searched: { keywords: "analyst" }, jobs: [job("Junior Analyst", "https://jobs.example/ja")], add_known: true })).json).toMatchObject({
      added: 1,
      postings: [{ number: 1, title: "Junior Analyst", dismissed: true }],
    });
  });

  it("removes a past search, and keeps the postings saved from it", async () => {
    const search = await storeSearch([found("p1", "Product Designer")]);
    await savePosting(found("p1", "Product Designer"));
    expect((await tool("remove_search", { search_id: search.id })).json).toMatchObject({
      search_id: search.id,
      removed: true,
      message: "Search removed. Saved postings from it stay in Saved.",
      link: "https://dossier.example/jobs?view=history",
    });
    expect(await prisma().postingSearch.count()).toBe(0);
    expect(await prisma().posting.count()).toBe(1);
    expect(await tool("remove_search", { search_id: search.id })).toMatchObject({ isError: true, text: "That search is no longer kept." });
  });

  it("has Dossier's own model score a posting, and follows a scoring under way", async () => {
    const search = await storeSearch([found("p1", "Product Designer")]);
    fake.aiUsable = false;
    const yourself = await tool("score_with_dossier", { search_id: search.id, number: 1 });
    expect(yourself).toMatchObject({ isError: true, text: expect.stringContaining("save_job_scores") });
    expect(startJob).not.toHaveBeenCalled();

    fake.aiUsable = true;
    expect((await tool("score_with_dossier", { search_id: search.id, number: 1 })).json).toMatchObject({
      task_id: "score-job",
      status: "started",
      title: "Product Designer",
      company: "Acme",
      link: `https://dossier.example/jobs?search=${search.id}`,
      next: "Call check_task with this task_id until it's done.",
    });
    expect(startJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "posting-score" }), { posting: found("p1", "Product Designer") }, { key: "posting-score:JSEARCH:p1" });

    const running = await prisma().job.create({ data: { type: "posting-score", key: "posting-score:JSEARCH:p1", status: "RUNNING", input: {} } });
    const row = await savePosting(found("p1", "Product Designer"));
    expect((await tool("score_with_dossier", { posting_id: row.id })).json).toMatchObject({ task_id: running.id, title: "Product Designer" });
    expect(startJob).toHaveBeenCalledTimes(1);

    expect(await tool("score_with_dossier", { posting_id: "gone" })).toMatchObject({ isError: true, text: "That posting is no longer in Dossier." });
    expect(await tool("score_with_dossier", { search_id: search.id, number: 5 })).toMatchObject({ isError: true });
    expect(await tool("score_with_dossier", { search_id: "gone", number: 1 })).toMatchObject({ isError: true, text: "That search is no longer kept. Search again." });
    expect(await tool("score_with_dossier", {})).toMatchObject({ isError: true, text: "Give search_id and number, or posting_id." });
  });

  it("suggests search words from the profile, as the profile editor does, with Senior only when wanted", async () => {
    // A plain latest title, so that "Senior" is a guess from the years the roles add up to.
    await prisma().experience.updateMany({ data: { role: "Product Designer" } });
    const profile = await loadProfile();
    const now = new Date();
    const expected = searchWords(profile, now);
    expect(expected.seniorYears).not.toBeNull();
    const answer = await tool("get_search_words");
    expect(answer.isError).toBe(false);
    expect(answer.json).toMatchObject({ german: expected.german, best: searchChips(expected), link: "https://dossier.example/profile" });
    const groups = answer.json.groups as { title: string; words: { text: string; language: string; why: string }[] }[];
    expect(groups.map((group) => group.title)).toEqual(expected.groups.map((group) => group.title));
    expect(groups.flatMap((group) => group.words.map((word) => word.text))).toEqual(expected.groups.flatMap((group) => group.words.map((word) => word.text)));
    expect(groups.every((group) => group.words.every((word) => word.text.split(/\s+/).length <= 3 && word.why))).toBe(true);

    const without = await tool("get_search_words", { senior: false });
    const words = (without.json.groups as { words: { text: string }[] }[]).flatMap((group) => group.words.map((word) => word.text));
    expect(words).toEqual(searchWords(profile, now, { senior: false }).groups.flatMap((group) => group.words.map((word) => word.text)));
    expect(words.some((word) => /^Senior /.test(word))).toBe(false);
    expect(groups.flatMap((group) => group.words.map((word) => word.text)).some((word) => /^Senior /.test(word))).toBe(true);
    expect(without.json.senior_years).toEqual(expected.seniorYears ?? undefined);
  });

  it("says what is missing when the profile has nothing to suggest from", async () => {
    await prisma().experience.deleteMany();
    await prisma().skill.deleteMany();
    await prisma().profileField.deleteMany({ where: { key: { in: ["headline"] } } });
    expect(await tool("get_search_words")).toMatchObject({ isError: false, json: { groups: [], message: expect.stringContaining("Fill them in on Profile"), link: "https://dossier.example/profile" } });
  });

  it("marks the search words as read-only", async () => {
    const { tools } = (await rpc("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    expect(tools.find((entry) => entry.name === "get_search_words")?.annotations).toEqual({ readOnlyHint: true });
  });
});
