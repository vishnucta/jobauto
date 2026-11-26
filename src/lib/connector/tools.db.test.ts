import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentKind } from "@/generated/prisma/enums";
import { trimmedSchema, unitsSchema } from "@/lib/application-data";
import type { FoundPosting } from "@/lib/job-search/search";
import { prepareApplicationJob } from "@/lib/jobs/prepare-application";
import { startJob } from "@/lib/jobs/runner";
import { keepFound } from "@/lib/library";
import { copyProfile } from "@/lib/profiles";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";

import { seedBuiltIns } from "../../../prisma/seed/built-ins";
import { seedDemo } from "../../../prisma/seed/demo";

import { connectorDraftJob } from "./draft";
import { handOffPastedPosting } from "./handoff";
import { challengeOf, exchangeCode, issueCode, registerClient } from "./oauth";

// The Claude connector's tools (#221), called as Claude calls them, through
// /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const fake = vi.hoisted(() => ({ aiUsable: false, fetched: { ok: true, text: "Fetched posting text", url: "https://jobs.example/fetched" } as Record<string, unknown> }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => fake.aiUsable }));
vi.mock("@/lib/posting-fetch", () => ({ fetchPosting: vi.fn(async () => fake.fetched) }));
vi.mock("@/lib/job-search/find", () => ({
  fullText: vi.fn(async () => "The whole posting from its source"),
  askSource: vi.fn(async () => ({ ok: true, source: "JSEARCH", postings: [found("p3", "Page two posting")], next: null })),
}));
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "draft-job"),
}));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

function found(id: string, title: string, complete = true) {
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
    description: complete ? `${title}: Figma, design systems.` : "The start",
    complete,
  };
}

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  fake.aiUsable = false;
  fake.fetched = { ok: true, text: "Fetched posting text", url: "https://jobs.example/fetched" };
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
});
afterAll(() => prisma().$disconnect());

/** Calls a tool; its text answer, parsed when it's JSON, and whether it's an error. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> & unknown[] }> {
  const response = await POST(
    new Request("https://dossier.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = await response.text();
  const { result } = JSON.parse(body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6));
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> & unknown[] };
}

/** A kept search with what it found, in the library as a search keeps it (E22-5). */
const storeSearch = async (postings: unknown[]) => {
  const search = await prisma().postingSearch.create({
    data: {
      source: "JSEARCH",
      query: { keywords: "designer", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" },
      portals: [{ id: "JSEARCH", status: "done", found: postings.length, next: "page:2", message: null }],
      found: postings.length,
    },
  });
  await keepFound(search.id, "JSEARCH", postings as FoundPosting[]);
  return search;
};

/** save_job_scores' answers about one posting: one requirement, covered. */
const answers = {
  requirements: [{ text: "Go in production", must_have: true, covered: true, evidence: "Engineer at Northwind" }],
  work: { level: 3, reason: "" },
  extra: { level: 1, reason: "" },
  education: { level: 2, reason: "" },
  seniority: { fit: "fits", reason: "" },
  location: { fit: "fits", reason: "" },
};

describe("the Claude connector's tools (#221)", () => {
  it("lists the applications, newest first, by status, and reads one without notes, sender or signature", async () => {
    const all = await tool("list_applications");
    expect(all.json.length).toBeGreaterThan(3);
    expect(all.json[0]).toMatchObject({ status: expect.any(String), link: expect.stringMatching(/^https:\/\/dossier\.example\/applications\//) });
    const drafts = await tool("list_applications", { status: "DRAFT", limit: 2 });
    expect(drafts.json.every((row) => (row as { status: string }).status === "Draft")).toBe(true);

    const ledgerly = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" }, include: { documents: true } });
    await prisma().note.create({ data: { applicationId: ledgerly.id, body: "Private: salary floor 80k" } });
    const one = await tool("get_application", { id: ledgerly.id });
    expect(one.json).toMatchObject({ id: ledgerly.id, company: "Ledgerly", link: `https://dossier.example/applications/${ledgerly.id}` });
    expect(one.json.resume).toContain("## Summary");
    expect(one.text).not.toContain("Private: salary floor");
    expect(one.json.cover_letter).not.toContain("## Sender");
    expect(one.json.cover_letter).not.toContain("## Signature");
    expect(await tool("get_application", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("moves an application along, approving a job agent draft first", async () => {
    const ledgerly = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } });
    await prisma().application.update({ where: { id: ledgerly.id }, data: { status: "DRAFT", awaitingReview: true } });
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "agent-1", dedupeKey: "agent-1", status: "DRAFTED", applicationId: ledgerly.id } });
    expect((await tool("set_application_status", { id: ledgerly.id, status: "SENT" })).json).toEqual({ id: ledgerly.id, status: "Sent", changed: true });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: ledgerly.id } })).toMatchObject({ status: "SENT", awaitingReview: false });
    expect((await tool("set_application_status", { id: ledgerly.id, status: "SENT" })).json).toMatchObject({ changed: false });
    expect(await tool("set_application_status", { id: "gone", status: "SENT" })).toMatchObject({ isError: true });
  });

  it("reads each posting's German against hers, as the screens do (germanDecision, jobauto fork)", async () => {
    await prisma().language.deleteMany();
    await prisma().language.create({ data: { name: "German", level: "A2" } });
    const asks = { ...found("g1", "Analyst"), description: "Analyst: regulatory reporting. Sehr gute Deutschkenntnisse sind erforderlich." };
    await storeSearch([asks, found("g2", "Designer")]);
    const listed = (await tool("list_postings", { view: "open" })).json as unknown as { open: { postings: { title: string; german?: string }[] } };
    const german = listed.open.postings.find((posting) => posting.title === "Analyst")!.german;
    expect(german).toBe("needs more German than she has. The ad asks for more German (C1) than your A2: “Sehr gute Deutschkenntnisse sind erforderlich.”");
    // A posting that says nothing about German has no line.
    expect(listed.open.postings.find((posting) => posting.title === "Designer")!.german).toBeUndefined();
  });

  it("reads a posting from wherever Claude got it", async () => {
    const search = await storeSearch([found("p1", "Product Designer"), found("p2", "Brand Designer", false)]);
    expect((await tool("get_posting", { search_id: search.id, number: 1 })).json).toMatchObject({ title: "Product Designer", url: "https://jobs.example/p1" });
    expect((await tool("get_posting", { search_id: search.id, number: 2 })).json.text).toContain("The whole posting from its source");
    expect(await tool("get_posting", { search_id: search.id, number: 9 })).toMatchObject({ isError: true });

    const row = await prisma().posting.create({ data: { source: "JSEARCH", externalId: "p9", title: "UX Writer", company: "Acme", description: "The start", complete: false } });
    expect((await tool("get_posting", { posting_id: row.id })).json).toMatchObject({ title: "UX Writer", text: expect.stringContaining("The whole posting from its source") });
    expect(await tool("get_posting", { posting_id: "gone" })).toMatchObject({ isError: true, text: "That posting is no longer in Dossier. Open it again from Positions." });

    const chat = await handOffPastedPosting({ text: "Pasted: Senior Designer at Acme", url: "https://jobs.example/pasted" });
    const pasteId = /paste_id "([^"]+)"/.exec(new URL(chat).searchParams.get("q")!)![1];
    expect((await tool("get_posting", { paste_id: pasteId })).json).toMatchObject({ text: "Pasted: Senior Designer at Acme", url: "https://jobs.example/pasted" });
    expect(await tool("get_posting", { paste_id: "00000000-0000-0000-0000-000000000000" })).toMatchObject({ isError: true });

    expect((await tool("get_posting", { posting_url: "https://jobs.example/fetched" })).json).toMatchObject({ text: "Fetched posting text" });
    fake.fetched = { ok: false, error: "That page couldn't be reached." };
    expect((await tool("get_posting", { posting_url: "https://jobs.example/broken" })).text).toBe("That page couldn't be reached. Paste the posting's text as posting_text instead.");
    expect(await tool("get_posting")).toMatchObject({ isError: true, text: "Give posting_id, paste_id, search_id and number, posting_url, or posting_text." });
  });

  it("saves an application Claude wrote, linked to the posting it came from", async () => {
    const search = await storeSearch([found("p1", "Product Designer")]);
    const profile = await prisma().experience.findFirstOrThrow({ orderBy: { sort: "asc" } });
    const saved = await tool("save_application", {
      search_id: search.id,
      number: 1,
      details: { company: "Acme", role: "Product Designer", location: "Berlin" },
      resume: { summary: "Designer who ships calm products.", roles: [{ id: profile.id, bullets: ["Led the payments redesign"] }], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "I'd like to help Acme." }] },
      match: [{ requirement: "Figma", result: "covered" }],
    });
    expect(saved.json).toMatchObject({ status: "Draft", application_id: expect.any(String) });
    const id = saved.json.application_id as string;
    expect(await prisma().application.findUniqueOrThrow({ where: { id } })).toMatchObject({ company: "Acme", status: "DRAFT", postingUrl: "https://jobs.example/p1" });
    expect((await prisma().posting.findFirstOrThrow({ where: { externalId: "p1" } })).applicationId).toBe(id);

    // A link Dossier can't read doesn't stop pasted text, and the link is kept.
    fake.fetched = { ok: false, error: "That page couldn't be reached." };
    const pasted = await tool("save_application", {
      posting_url: "https://jobs.example/sign-in-only",
      posting_text: "Product Designer at Acme",
      details: { company: "Acme", role: "Product Designer" },
      resume: { summary: "Designer who ships calm products.", roles: [], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "I'd like to help Acme." }] },
    });
    expect(pasted.json).toMatchObject({ status: "Draft" });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: pasted.json.application_id as string } })).toMatchObject({
      postingUrl: "https://jobs.example/sign-in-only",
    });

    // One application per posting: saving again, from the search or from the same link, answers with the first and saves nothing.
    const count = await prisma().application.count();
    const again = await tool("save_application", {
      search_id: search.id,
      number: 1,
      details: { company: "Acme", role: "Product Designer" },
      resume: { summary: "Designer who ships calm products.", roles: [], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "Hello again." }] },
    });
    expect(again.json).toMatchObject({ application_id: id, status: "exists", next: expect.stringContaining("update_application") });
    const sameLink = await tool("save_application", {
      posting_url: "https://jobs.example/sign-in-only",
      posting_text: "Product Designer at Acme",
      details: { company: "Acme", role: "Product Designer" },
      resume: { summary: "Designer who ships calm products.", roles: [], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "Hello again." }] },
    });
    expect(sameLink.json).toMatchObject({ application_id: pasted.json.application_id, status: "exists" });
    expect(await prisma().application.count()).toBe(count);

    expect(await tool("save_application", { details: { company: "Acme", role: "Designer" }, resume: { summary: "", roles: [], skills: [] }, cover_letter: { paragraphs: [{ text: "Hi" }] } })).toMatchObject({
      isError: true,
    });
  });

  it("changes a saved Draft in place, and refuses one that was sent", async () => {
    const saved = await tool("save_application", {
      posting_text: "Product Designer at Acme",
      details: { company: "Acme", role: "Product Designer" },
      resume: { summary: "Designer who ships calm products.", roles: [], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "I'd like to help Acme." }] },
      match: [{ requirement: "Figma", result: "covered" }],
    });
    const id = saved.json.application_id as string;

    const updated = await tool("update_application", { application_id: id, change: "Warmer summary", resume: { summary: "Designer who ships warm products.", roles: [], skills: ["Figma"] } });
    expect(updated.json).toMatchObject({ application_id: id, status: "Draft" });
    expect((await tool("get_application", { id })).json.resume).toContain("Designer who ships warm products.");
    expect(await prisma().application.count({ where: { company: "Acme" } })).toBe(1);
    // A part left out stays as it was.
    expect((await prisma().application.findUniqueOrThrow({ where: { id } })).match).toMatchObject({ items: [{ requirement: "Figma" }] });

    expect(await tool("update_application", { application_id: id, change: "Nothing" })).toMatchObject({ isError: true });
    await tool("set_application_status", { id, status: "SENT" });
    expect((await tool("update_application", { application_id: id, change: "Too late", match: [] })).text).toContain("Only a Draft");
  });

  it("keeps what was left out of the resume out when it changes a Draft", async () => {
    const saved = await tool("save_application", {
      posting_text: "Product Designer at Acme",
      details: { company: "Acme", role: "Product Designer" },
      resume: { summary: "Designer who ships calm products.", roles: [], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "I'd like to help Acme." }] },
    });
    const id = saved.json.application_id as string;
    const where = { applicationId_kind: { applicationId: id, kind: DocumentKind.RESUME } };
    // "Leave out" on a project, as the application page does it.
    const units = unitsSchema.parse((await prisma().document.findUniqueOrThrow({ where })).units);
    const index = units.findIndex((unit) => unit.id.startsWith("project:"));
    expect(index).toBeGreaterThanOrEqual(0);
    const [project] = units.splice(index, 1);
    await prisma().document.update({ where, data: { units, trimmed: [{ kind: "unit", unit: project, index, byHand: true }] } });

    const projectId = project.id.slice("project:".length);
    await tool("update_application", {
      application_id: id,
      change: "Warmer summary",
      resume: { summary: "Designer who ships warm products.", roles: [], projects: [{ id: projectId, bullets: ["Rewrote the checkout."] }], skills: ["Figma"] },
    });

    const after = await prisma().document.findUniqueOrThrow({ where });
    expect(unitsSchema.parse(after.units).map((unit) => unit.id)).not.toContain(project.id);
    // Listed once, and Put back brings the revised part.
    expect(trimmedSchema.parse(after.trimmed)).toEqual([{ kind: "unit", unit: expect.objectContaining({ id: project.id, text: expect.stringContaining("Rewrote the checkout.") }), index, byHand: true }]);
  });

  it("no longer lists bullets taken off to fit the page once the changed resume has them again", async () => {
    const saved = await tool("save_application", {
      posting_text: "Product Designer at Acme",
      details: { company: "Acme", role: "Product Designer" },
      resume: { summary: "Designer who ships calm products.", roles: [], skills: ["Figma"] },
      cover_letter: { paragraphs: [{ text: "I'd like to help Acme." }] },
    });
    const id = saved.json.application_id as string;
    const where = { applicationId_kind: { applicationId: id, kind: DocumentKind.RESUME } };
    // Fit to one page took a role's last line off, and a line no role has any more.
    const units = unitsSchema.parse((await prisma().document.findUniqueOrThrow({ where })).units);
    const role = units.find((unit) => unit.id.startsWith("experience:") && unit.text.includes("\n"))!;
    const last = role.text.split("\n").at(-1)!;
    role.text = role.text.split("\n").slice(0, -1).join("\n");
    const gone = { kind: "bullets" as const, unitId: role.id, label: role.label, lines: ["A line from an older profile."] };
    await prisma().document.update({ where, data: { units, trimmed: [{ kind: "bullets", unitId: role.id, label: role.label, lines: [last] }, gone] } });

    // The role keeps its profile lines, so the line is back on the resume: Put back would add it twice.
    const resume = { summary: "Designer who ships warm products.", roles: [], skills: ["Figma"] };
    await tool("update_application", { application_id: id, change: "Warmer summary", resume });
    const after = await prisma().document.findUniqueOrThrow({ where });
    expect(unitsSchema.parse(after.units).find((unit) => unit.id === role.id)?.text).toContain(last);
    expect(trimmedSchema.parse(after.trimmed)).toEqual([gone]);

    await prisma().document.update({ where, data: { trimmed: [{ kind: "bullets", unitId: role.id, label: role.label, lines: [last] }] } });
    await tool("update_application", { application_id: id, change: "Warmer still", resume });
    expect((await prisma().document.findUniqueOrThrow({ where })).trimmed).toBeNull();
  });

  it("has Dossier's own model draft one only when there is one, as Prepare it for me does for a posting Positions keeps (round 2 of the audit)", async () => {
    expect((await tool("draft_application", { posting_text: "Designer at Acme" })).text).toContain("save_application");
    fake.aiUsable = true;
    expect((await tool("draft_application", { posting_text: "Designer at Acme", note: "Stress Figma" })).json).toMatchObject({
      task_id: "draft-job",
      status: "started",
      next: expect.stringContaining("check_task"),
    });
    expect(vi.mocked(startJob)).toHaveBeenLastCalledWith(connectorDraftJob, expect.objectContaining({ posting: "Designer at Acme", note: "Stress Figma", postingId: null }));
    expect(await tool("draft_application", {})).toMatchObject({ isError: true });

    // A posting Positions keeps goes through Prepare it for me, with the note, and the profile only when one is named.
    const row = await prisma().posting.create({ data: { source: "JSEARCH", externalId: "p9", title: "Designer", company: "Acme", description: "Figma, design systems.", complete: true } });
    expect((await tool("draft_application", { posting_id: row.id, note: "Stress Figma" })).json).toMatchObject({ task_id: "draft-job", status: "started", posting_id: row.id });
    expect(vi.mocked(startJob)).toHaveBeenLastCalledWith(prepareApplicationJob, { postingId: row.id, profileId: null, note: "Stress Figma" }, { key: `prepare:${row.id}` });
    expect(await tool("draft_application", { posting_id: "gone" })).toMatchObject({ isError: true, text: expect.stringContaining("no longer kept") });
    // One under way is followed rather than started again.
    const running = await prisma().job.create({ data: { type: "prepare-application", status: "RUNNING", key: `prepare:${row.id}`, input: { postingId: row.id } } });
    const calls = vi.mocked(startJob).mock.calls.length;
    expect((await tool("draft_application", { posting_id: row.id })).json).toMatchObject({ task_id: running.id, status: "started" });
    expect(vi.mocked(startJob).mock.calls.length).toBe(calls);
    // A posting with an application answers with it: no second one.
    const made = await prisma().application.create({ data: { title: "Designer", company: "Acme" } });
    await prisma().posting.update({ where: { id: row.id }, data: { applicationId: made.id } });
    expect((await tool("draft_application", { posting_id: row.id })).json).toMatchObject({ application_id: made.id, status: "exists", link: `https://dossier.example/applications/${made.id}` });
    expect(vi.mocked(startJob).mock.calls.length).toBe(calls);
  });

  it("reads and writes from the profile asked for by name, or the first (E24-6)", async () => {
    const backend = await copyProfile(TEST_PROFILE_ID, "Backend");
    const first = await prisma().profile.findUniqueOrThrow({ where: { id: TEST_PROFILE_ID } });
    await prisma().profile.update({ where: { id: backend }, data: { headline: "Backend engineer" } });

    expect((await tool("get_profile")).json).toMatchObject({
      profile: first.name,
      profiles: [first.name, "Backend"],
      // What save_job_scores judges seniority and location against.
      jobsItsFor: "Senior to Lead or director",
      whereItWantsToWork: { waysOfWorking: ["On-site", "Hybrid", "Remote"] },
      link: `https://dossier.example/profile?profile=${TEST_PROFILE_ID}`,
    });
    expect((await tool("get_profile", { profile: "backend" })).json).toMatchObject({ profile: "Backend", headline: "Backend engineer", link: `https://dossier.example/profile?profile=${backend}` });
    expect((await tool("get_profile", { profile: backend })).json).toMatchObject({ profile: "Backend" });
    expect(await tool("get_profile", { profile: "Frontend" })).toMatchObject({ isError: true, text: `There's no profile called "Frontend". The profiles are: "${first.name}", "Backend".` });

    const role = await prisma().experience.findFirstOrThrow({ where: { profileId: backend }, orderBy: { sort: "asc" } });
    const saved = await tool("save_application", {
      posting_text: "Backend Engineer at Acme",
      details: { company: "Acme", role: "Backend Engineer" },
      resume: { summary: "Engineer who ships calm systems.", roles: [{ id: role.id, bullets: ["Ran the payments platform"] }], skills: [] },
      cover_letter: { paragraphs: [{ text: "I'd like to help Acme." }] },
      profile: "Backend",
    });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: saved.json.application_id as string } })).toMatchObject({ profileId: backend });
    expect(await tool("save_application", { posting_text: "x", details: { company: "A", role: "B" }, resume: { summary: "", roles: [], skills: [] }, cover_letter: { paragraphs: [{ text: "Hi" }] }, profile: "Frontend" })).toMatchObject({
      isError: true,
    });

    // Scores are kept per profile (E25-5).
    const search = await storeSearch([found("p1", "Backend Engineer")]);
    expect((await tool("save_job_scores", { search_id: search.id, scores: [{ number: 1, ...answers }], profile: "Backend" })).isError).toBe(false);
    expect(await prisma().postingScore.findMany({ select: { externalId: true, profileId: true } })).toEqual([{ externalId: "p1", profileId: backend }]);

    fake.aiUsable = true;
    await tool("draft_application", { posting_text: "Backend Engineer at Acme", profile: "Backend" });
    expect(vi.mocked(startJob)).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ profileId: backend }));
    await tool("draft_application", { posting_text: "Backend Engineer at Acme" });
    expect(vi.mocked(startJob)).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ profileId: TEST_PROFILE_ID }));
  });

  it("shows more of a search, and scores postings handed over by id", async () => {
    const search = await storeSearch([found("p1", "Product Designer"), found("p2", "Brand Designer")]);
    expect((await tool("more_jobs", { search_id: search.id })).json).toMatchObject({ added: 1, postings: [{ number: 3, title: "Page two posting" }] });
    expect(await tool("more_jobs", { search_id: "gone" })).toMatchObject({ isError: true, text: "That search is no longer kept. Search again." });

    const row = await prisma().posting.create({ data: { source: "JSEARCH", externalId: "p7", title: "Design Lead", company: "Acme" } });
    expect((await tool("save_job_scores", { scores: [{ posting_id: row.id, ...answers }] })).json).toMatchObject({
      saved: [{ posting_id: row.id, covered: "1 of 1", fit: "Strong fit" }],
      link: "https://dossier.example/jobs?view=saved",
    });
    expect(await tool("save_job_scores", { search_id: "gone", scores: [{ number: 1, ...answers }] })).toMatchObject({ isError: true });

    // As in Dossier, nothing is scored against a profile whose levels aren't chosen (E24-3).
    await prisma().profile.update({ where: { id: TEST_PROFILE_ID }, data: { levelFrom: null, levelTo: null } });
    expect(await tool("save_job_scores", { scores: [{ posting_id: row.id, ...answers }] })).toMatchObject({ isError: true, text: expect.stringContaining("Set the levels for") });
    expect((await tool("get_profile")).json).not.toHaveProperty("jobsItsFor");
  });
});
