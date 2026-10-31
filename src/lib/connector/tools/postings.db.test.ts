import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startJob } from "@/lib/jobs/runner";
import { saveScore } from "@/lib/posting-scores";
import { dismissPosting, savePosting } from "@/lib/postings";
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
    data: { source: "JSEARCH", query: { keywords: "designer", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" }, postings: postings as object[], found: postings.length, next: "page:2", createdAt },
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
});
