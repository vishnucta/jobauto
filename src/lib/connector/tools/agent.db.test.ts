import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import type { StartupEmail } from "@/lib/startups/types";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The job agent's and Startups' tools (jobauto fork), called as Claude calls
// them, through /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
// Background work is only started here, never run: no source, model or site is asked anything.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async (definition: { type: string }) => `${definition.type}-task`),
}));
// The agent runs only with an AI provider and a job source set up.
vi.mock("@/lib/ai/config", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ai/config")>()), isAiConfigured: async () => true }));
vi.mock("@/lib/job-search/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/job-search/config")>()),
  loadJobSearchConfig: async () => ({ source: "JSEARCH", saved: true, jsearch: { key: "k", host: "openwebninja", keyState: "set" }, adzuna: { appId: "", key: null, keyState: "none" } }),
  credentialsFor: () => ({ key: "k", host: "openwebninja" }),
}));
vi.mock("@/lib/time-zone", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/time-zone")>()), lastKnownTimeZone: async () => "Europe/Berlin" }));
// Startups' sites answer from here, never the internet.
const site = vi.hoisted(() => ({ emails: [] as StartupEmail[], noApplicationsFrom: "" }));
vi.mock("@/lib/startups/emails", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/startups/emails")>()),
  lookUpSite: vi.fn(async () => ({ emails: site.emails, noApplicationsFrom: site.noApplicationsFrom, refused: false })),
}));

import { POST } from "@/app/api/mcp/route";
import { startJob } from "@/lib/jobs/runner";
import { lookUpSite } from "@/lib/startups/emails";
import { sweepStartups } from "@/lib/startups/store";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const query = { keywords: "Data scientist", place: "Berlin", country: "de", radiusKm: 25 as const, remoteOnly: false, postedWithin: "any" as const };

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", agentEnabled: true, agentQuery: query });
  Object.assign(site, { emails: [], noApplicationsFrom: "" });
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
});
afterAll(() => prisma().$disconnect());

/** Sends one MCP request; the answer's JSON-RPC result. */
async function call(method: string, params: Record<string, unknown>) {
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
  const result = await call("tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> & unknown[] };
}

/** A posting the agent found and scored. */
const find = (externalId: string, score: number, data: Record<string, unknown> = {}) =>
  prisma().agentCandidate.create({
    data: {
      source: "JSEARCH",
      externalId,
      dedupeKey: externalId,
      title: `Posting ${externalId}`,
      company: "Ledgerly",
      place: "Berlin",
      url: `https://jobs.example/${externalId}`,
      description: `The whole posting ${externalId}`,
      complete: true,
      score,
      reasons: ["Python"],
      redFlags: [],
      ...data,
    },
  });

/** A startup a refresh found. */
const startup = (data: Record<string, unknown> = {}) =>
  prisma().startup.create({
    data: {
      source: "HN",
      externalId: `hn-${Math.random()}`,
      company: "Acme",
      website: "https://acme.io",
      summary: "Android apps for farmers",
      details: "Acme | Android Engineer | Rotterdam\nKotlin, Android. Write to jobs@acme.io.",
      location: "Rotterdam, Netherlands",
      roles: ["Android Engineer"],
      emails: [],
      links: [{ label: "Hacker News", url: "https://news.ycombinator.com/item?id=1" }],
      reasons: ["In Rotterdam"],
      score: 80,
      ...data,
    },
  });

const address = (email: string, change: Partial<StartupEmail> = {}): StartupEmail => ({ email, label: "Hiring", from: "https://acme.io/careers", onRequest: false, foundAt: "2026-10-23T08:00:00.000Z", ...change });

describe("the job agent's tools", () => {
  it("reads the agent: its settings, runs, drafts waiting for review and finds, best first", async () => {
    const ledgerly = await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } });
    await prisma().application.update({ where: { id: ledgerly.id }, data: { awaitingReview: true } });
    const draft = await find("draft", 90, { status: "DRAFTED", applicationId: ledgerly.id });
    const good = await find("good", 75, { redFlags: ["On-call rota"] });
    await find("better", 88);
    const low = await find("low", 30);
    await find("gone", 95, { status: "DISMISSED" });
    const job = await prisma().job.create({ data: { type: "agent-draft", key: `agent-candidate:${good.id}`, input: { candidateId: good.id } } });
    await saveSettings({ agentRuns: [{ at: "2026-10-23T05:00:00.000Z", manual: false, message: "2 new postings are waiting for a look." }] });

    const agent = await tool("get_job_agent");
    expect(agent.json).toMatchObject({
      settings: { enabled: true, keywords: "Data scientist", place: "Berlin", country: "de", radius_km: 25, min_score: 70, auto_draft: false, time_zone: "Europe/Berlin" },
      searches_for: "Data scientist · Berlin, 25 km · via JSearch",
      recent_runs: [{ result: "2 new postings are waiting for a look." }],
      drafts: [{ find_id: draft.id, application_id: ledgerly.id, link: `https://dossier.example/applications/${ledgerly.id}` }],
      finds: [{ title: "Posting better", score: 88 }, { find_id: good.id, reasons: ["Python"], red_flags: ["On-call rota"], drafting_task_id: job.id }],
      below_minimum_count: 1,
      link: "https://dossier.example/agent",
    });
    expect(agent.json).not.toHaveProperty("below_minimum");
    expect((await tool("get_job_agent", { include_below_minimum: true })).json.below_minimum).toMatchObject([{ find_id: low.id, score: 30 }]);

    // One find whole, with its draft's text, but not the letter's sender or signature.
    const one = await tool("get_job_agent", { find_id: draft.id });
    expect(one.json).toMatchObject({ find_id: draft.id, status: "Draft ready for review", posting: "The whole posting draft", application_id: ledgerly.id });
    expect(one.json.resume).toContain("## Summary");
    expect(one.json.cover_letter).not.toContain("## Sender");
    expect(one.json.cover_letter).not.toContain("## Signature");
    expect(await tool("get_job_agent", { find_id: "nope" })).toMatchObject({ isError: true, text: "That posting is no longer in the agent's queue." });
  });

  it("changes the agent's settings, and turns it on only with keywords and a country", async () => {
    await saveSettings({ agentEnabled: false, agentQuery: { ...query, keywords: "" } });
    expect(await tool("update_job_agent", { enabled: true })).toMatchObject({ isError: true, text: "Type what the agent should look for before turning it on." });
    expect(await tool("update_job_agent", { enabled: true, keywords: "Designer", country: "" })).toMatchObject({
      isError: true,
      text: "Choose a country for the search before turning the agent on.",
    });

    const saved = await tool("update_job_agent", { enabled: true, keywords: "Product designer", country: "Germany", place: "", hour: 9, min_score: 80, auto_draft: true, max_drafts: 2 });
    expect(saved.json).toMatchObject({
      saved: true,
      settings: { enabled: true, keywords: "Product designer", place: "", country: "de", hour: 9, min_score: 80, auto_draft: true, max_drafts: 2 },
      link: "https://dossier.example/agent",
    });
    expect(await loadSettings()).toMatchObject({ agentEnabled: true, agentQuery: { ...query, keywords: "Product designer", place: "" }, agentHour: 9, agentMinScore: 80, agentMaxScores: 15 });

    expect(await tool("update_job_agent", { country: "Atlantis" })).toMatchObject({ isError: true, text: "Dossier doesn't know that country. Give its name or ISO code, e.g. 'Germany' or 'de'." });
    expect(await tool("update_job_agent", {})).toMatchObject({ isError: true, text: "Say what to change, or give run_now: true to run it now." });
  });

  it("runs it now, reuses a run under way, and keeps to the limits", async () => {
    expect((await tool("update_job_agent", { run_now: true })).json).toMatchObject({ task_id: "agent-scan-task", status: "started", link: "https://dossier.example/agent" });
    expect(startJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "agent-scan" }), { manual: true }, { key: "agent" });

    const running = await prisma().job.create({ data: { type: "agent-scan", key: "agent", status: "RUNNING", input: { manual: false } } });
    expect((await tool("update_job_agent", { run_now: true })).json).toMatchObject({ task_id: running.id, already_running: true });
    await prisma().job.delete({ where: { id: running.id } });

    await saveSettings({ agentRuns: [{ at: new Date(Date.now() - 20 * 60_000).toISOString(), manual: false, message: null }] });
    expect(await tool("update_job_agent", { run_now: true })).toMatchObject({ isError: true, text: "The agent ran less than an hour ago. Try again in 40 minutes." });
    expect(await tool("update_job_agent", { min_score: 60, run_now: true })).toMatchObject({
      isError: true,
      text: "Saved the changes, but it can't run now. The agent ran less than an hour ago. Try again in 40 minutes.",
    });
    expect((await loadSettings()).agentMinScore).toBe(60);

    await saveSettings({ agentEnabled: false });
    expect(await tool("update_job_agent", { run_now: true })).toMatchObject({ isError: true, text: "Turn the job agent on in Settings → Job agent first." });
  });

  it("prepares a find's draft in the background, and approves a draft into Applications", async () => {
    const scored = await find("good", 80);
    expect((await tool("act_on_agent_find", { find_id: scored.id, action: "prepare_draft" })).json).toMatchObject({ task_id: "agent-draft-task", status: "started", find_id: scored.id });
    expect(startJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "agent-draft" }), { candidateId: scored.id }, { key: `agent-candidate:${scored.id}` });
    const queued = await prisma().job.create({ data: { type: "agent-draft", key: `agent-candidate:${scored.id}`, input: { candidateId: scored.id } } });
    expect((await tool("act_on_agent_find", { find_id: scored.id, action: "prepare_draft" })).json).toMatchObject({ task_id: queued.id, already_running: true });

    const application = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    const drafted = await find("drafted", 90, { status: "DRAFTED", applicationId: application.id });
    expect((await tool("act_on_agent_find", { find_id: drafted.id, action: "prepare_draft" })).json).toMatchObject({ application_id: application.id, status: "Draft ready for review" });
    expect(await tool("act_on_agent_find", { find_id: scored.id, action: "approve" })).toMatchObject({ isError: true, text: "That draft isn't ready to approve." });
    expect((await tool("act_on_agent_find", { find_id: drafted.id, action: "approve" })).json).toMatchObject({
      application_id: application.id,
      status: "Draft",
      message: "Added to Applications as a draft. Nothing has been sent.",
      link: `https://dossier.example/applications/${application.id}`,
    });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: application.id } })).toMatchObject({ awaitingReview: false, status: "DRAFT" });
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: drafted.id } })).toMatchObject({ status: "APPROVED" });
    expect(await tool("act_on_agent_find", { find_id: drafted.id, action: "dismiss" })).toMatchObject({ isError: true, text: "That draft was approved: it's in Applications now." });
    expect(await tool("act_on_agent_find", { find_id: "nope", action: "prepare_draft" })).toMatchObject({ isError: true, text: "That posting is no longer in the agent's queue." });
  });

  it("dismisses a find, deleting its draft, and restores one from what Find jobs keeps", async () => {
    const application = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    const drafted = await find("drafted", 90, { status: "DRAFTED", applicationId: application.id });
    expect((await tool("act_on_agent_find", { find_id: drafted.id, action: "dismiss" })).json).toMatchObject({ status: "Dismissed", message: "Dismissed, with its draft if it had one. It won't come back." });
    expect(await prisma().application.count({ where: { id: application.id } })).toBe(0);

    const scored = await find("good", 80, { redFlags: ["On-call rota"] });
    await prisma().postingScore.create({ data: { source: "JSEARCH", externalId: "good", score: 80, reasons: ["Python"], redFlags: ["On-call rota"], scoredWith: "score-posting@1" } });
    expect(await tool("act_on_agent_find", { find_id: scored.id, action: "restore" })).toMatchObject({ isError: true, text: "That posting isn't dismissed." });
    expect((await tool("act_on_agent_find", { find_id: scored.id, action: "dismiss" })).json).toMatchObject({ message: "Dismissed. It won't come back unless it's restored." });
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: scored.id } })).toMatchObject({ status: "DISMISSED", url: "", description: "", reasons: [] });
    expect((await tool("get_job_agent", { include_dismissed: true })).json.dismissed).toMatchObject([
      { find_id: scored.id, title: "Posting good" },
      { find_id: drafted.id, title: "Posting drafted" },
    ]);

    expect((await tool("act_on_agent_find", { find_id: scored.id, action: "restore" })).json).toMatchObject({ status: "Waiting for a look", link: "https://dossier.example/agent" });
    expect(await prisma().agentCandidate.findUniqueOrThrow({ where: { id: scored.id } })).toMatchObject({
      status: "SCORED",
      url: "https://jobs.example/good",
      description: "The whole posting good",
      reasons: ["Python"],
      redFlags: ["On-call rota"],
    });
    // Out of Find jobs' Dismissed again, and not kept there for nothing.
    expect(await prisma().posting.count({ where: { externalId: "good" } })).toBe(0);

    // Once Find jobs no longer keeps the posting, there's nothing to bring it back from.
    await tool("act_on_agent_find", { find_id: scored.id, action: "dismiss" });
    await prisma().posting.deleteMany({ where: { externalId: "good" } });
    expect((await tool("get_job_agent", { include_dismissed: true })).json.dismissed).toMatchObject([{ find_id: drafted.id }]);
    expect(await tool("act_on_agent_find", { find_id: scored.id, action: "restore" })).toMatchObject({ isError: true, text: "Dossier no longer keeps that posting's details, so it can't come back." });
  });
});

describe("the Startups tools", () => {
  it("lists startups as the screen does, with their addresses, and reads one whole", async () => {
    expect((await tool("list_startups")).json).toMatchObject({ next: "Nothing has been looked for yet. Call refresh_startups.", total: 0, startups: [] });

    await saveSettings({
      startupsLastRefresh: {
        at: "2026-10-23T08:00:00.000Z",
        added: 3,
        sources: [
          { source: "YC", found: 2, error: null },
          { source: "HN", found: 0, error: "Hacker News took too long to answer" },
        ],
        emailsFound: 1,
      },
    });
    const acme = await startup({ emails: [address("jobs@acme.io")], notes: "Met them at a meetup" });
    await startup({ company: "Beta", score: 90, summary: "Fintech for farmers", details: "", website: "" });
    await startup({ company: "Kept", status: "SAVED" });

    const list = await tool("list_startups");
    expect(list.json).toMatchObject({
      last_refresh: expect.any(String),
      refresh_problems: ["Hacker News took too long to answer"],
      counts: { NEW: 2, SAVED: 1, CONTACTED: 0, DISMISSED: 0 },
      total: 2,
      startups: [
        { company: "Beta", match: 90 },
        {
          id: acme.id,
          company: "Acme",
          found_on: "Hacker News · Who is hiring?",
          status: "NEW",
          match: 80,
          reasons: ["In Rotterdam"],
          addresses: [{ email: "jobs@acme.io", label: "Hiring", published_on: "https://acme.io/careers" }],
          notes: "Met them at a meetup",
        },
      ],
      link: "https://dossier.example/startups",
    });
    expect(list.json).not.toHaveProperty("next");
    expect((await tool("list_startups", { status: "SAVED" })).json.startups).toMatchObject([{ company: "Kept" }]);
    expect((await tool("list_startups", { with_address: true })).json.startups).toMatchObject([{ company: "Acme" }]);
    expect((await tool("list_startups", { search: "fintech" })).json).toMatchObject({ total: 1, link: "https://dossier.example/startups?q=fintech" });

    expect((await tool("list_startups", { id: acme.id })).json).toMatchObject({ id: acme.id, post: expect.stringContaining("Kotlin, Android"), link: "https://dossier.example/startups?q=Acme" });
    expect(await tool("list_startups", { id: "gone" })).toMatchObject({ isError: true, text: "That startup is no longer in the list." });
  });

  it("refreshes as the Refresh button does, reusing a refresh under way", async () => {
    expect((await tool("refresh_startups")).json).toMatchObject({ task_id: "startups-refresh-task", status: "started", link: "https://dossier.example/startups" });
    expect(startJob).toHaveBeenLastCalledWith(expect.objectContaining({ type: "startups-refresh" }), {}, { key: "startups-refresh" });
    const running = await prisma().job.create({ data: { type: "startups-refresh", key: "startups-refresh", status: "RUNNING", input: {} } });
    expect((await tool("refresh_startups")).json).toMatchObject({ task_id: running.id });
    expect((await tool("list_startups")).json).toMatchObject({ refreshing_task_id: running.id });
  });

  it("changes a startup's status and notes, and looks on its own site for the addresses it publishes", async () => {
    const acme = await startup();
    expect((await tool("update_startup", { id: acme.id, status: "SAVED", notes: "Write after Monday" })).json).toMatchObject({
      id: acme.id,
      status: "SAVED",
      notes: "Write after Monday",
      link: "https://dossier.example/startups?q=Acme&view=saved",
    });

    site.emails = [address("jobs@acme.io")];
    const looked = await tool("update_startup", { id: acme.id, look_up: "addresses" });
    expect(looked.json).toMatchObject({ found: "Found 1 address on their site.", addresses: [{ email: "jobs@acme.io", label: "Hiring" }], site_checked: expect.any(String) });
    expect(lookUpSite).toHaveBeenLastCalledWith("https://acme.io", expect.objectContaining({ people: false }));
    expect((await tool("update_startup", { id: acme.id, look_up: "addresses" })).json.found).toBe("Their site doesn't publish an address for applications. Try their careers page.");

    site.emails = [address("jane@acme.io", { label: "Person", from: "https://acme.io/team", onRequest: true })];
    expect((await tool("update_startup", { id: acme.id, look_up: "people" })).json.found).toBe(
      "Found 1 address on their site. People's own addresses are dropped after 14 days unless the user writes to this startup.",
    );
    expect(lookUpSite).toHaveBeenLastCalledWith("https://acme.io", expect.objectContaining({ people: true }));

    site.noApplicationsFrom = "“We don't take unsolicited applications” (acme.io/careers)";
    expect((await tool("update_startup", { id: acme.id, look_up: "addresses" })).json).toMatchObject({ found: "Their site says they don't take unsolicited applications.", no_unsolicited_applications: site.noApplicationsFrom });
    // As the screen hides the button then, it doesn't look again.
    expect(await tool("update_startup", { id: acme.id, look_up: "addresses" })).toMatchObject({ isError: true, text: expect.stringMatching(/^Their site says they don't take unsolicited applications/) });

    const beta = await startup({ company: "Beta", website: "" });
    expect(await tool("update_startup", { id: beta.id, look_up: "addresses" })).toMatchObject({ isError: true, text: "Dossier doesn't know Beta's website, so it can't look there." });
    expect(await tool("update_startup", { id: beta.id })).toMatchObject({ isError: true, text: "Say what to change: status, notes, application_id or look_up." });
    expect(await tool("update_startup", { id: "gone", status: "SAVED" })).toMatchObject({ isError: true, text: "That startup is no longer in the list." });
  });

  it("links the application written to a startup, as Write to them does: it counts as contacted once sent, and keeps people's addresses", async () => {
    const jane = address("jane@acme.io", { label: "Person", from: "https://acme.io/team", onRequest: true });
    const acme = await startup({ emails: [address("jobs@acme.io"), jane], peopleCheckedAt: new Date("2026-10-23T08:00:00Z") });
    // A list only counts people's own addresses. Read alone, a startup gives them, and its post without any address, to write from.
    expect((await tool("list_startups")).json.startups).toMatchObject([{ id: acme.id, addresses: [{ email: "jobs@acme.io" }], people_addresses: 1 }]);
    const one = await tool("list_startups", { id: acme.id });
    expect(one.json.addresses).toMatchObject([{ email: "jobs@acme.io" }, { email: "jane@acme.io", label: "Person" }]);
    expect(one.json).not.toHaveProperty("people_addresses");
    expect(one.json.post).toContain("Kotlin, Android.");
    expect(one.json.post).not.toContain("jobs@acme.io");

    const written = await prisma().application.create({ data: { title: "Android Engineer · Acme", company: "Acme" } });
    expect((await tool("update_startup", { id: acme.id, application_id: written.id })).json).toMatchObject({
      id: acme.id,
      application_id: written.id,
      status: "NEW",
      message: "Linked: Startups opens this application, and counts the startup as contacted once it's sent.",
      link: "https://dossier.example/startups?q=Acme",
    });
    expect((await tool("update_startup", { id: acme.id, application_id: written.id })).isError).toBe(false);

    // Once it's sent, the startup counts as contacted, and the daily tidy-up keeps people's addresses only where an application was linked.
    await prisma().application.update({ where: { id: written.id }, data: { status: "SENT" } });
    expect((await tool("list_startups", { status: "CONTACTED" })).json.startups).toMatchObject([{ id: acme.id, application_id: written.id }]);
    const unlinked = await startup({ company: "Gamma", emails: [jane], peopleCheckedAt: new Date("2026-10-23T08:00:00Z"), seenAt: new Date("2026-11-29T00:00:00Z") });
    expect(await sweepStartups(new Date("2026-11-30T00:00:00Z"))).toMatchObject({ addressesDropped: 1 });
    expect((await tool("list_startups", { id: acme.id })).json.addresses).toMatchObject([{ email: "jobs@acme.io" }, { email: "jane@acme.io" }]);
    expect((await tool("list_startups", { id: unlinked.id })).json).not.toHaveProperty("addresses");

    // One startup per application, never an agent draft waiting for review, and not where the screen offers no Write to them.
    const beta = await startup({ company: "Beta" });
    expect(await tool("update_startup", { id: beta.id, application_id: written.id })).toMatchObject({ isError: true, text: "That application is already linked to Acme." });
    expect(await tool("update_startup", { id: beta.id, application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    const review = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true } });
    expect(await tool("update_startup", { id: beta.id, application_id: review.id })).toMatchObject({
      isError: true,
      text: "That application is a job agent draft waiting for review. Approve it first.",
    });
    const other = await prisma().application.create({ data: { title: "Other" } });
    expect(await tool("update_startup", { id: acme.id, application_id: other.id })).toMatchObject({ isError: true, text: "Acme is already linked to another application." });
    const closed = await startup({ company: "Closed", noApplicationsFrom: "“No unsolicited applications.” (closed.io/careers)" });
    expect(await tool("update_startup", { id: closed.id, application_id: other.id, notes: "Try their jobs page" })).toMatchObject({
      isError: true,
      text: "Their site says they don't take unsolicited applications: “No unsolicited applications.” (closed.io/careers). Apply through a posted job instead.",
    });
    // Refused before anything changed: the notes weren't saved either.
    expect(await prisma().startup.findUniqueOrThrow({ where: { id: closed.id } })).toMatchObject({ notes: "", applicationId: null });
    expect(await tool("update_startup", { id: "gone", application_id: other.id })).toMatchObject({ isError: true, text: "That startup is no longer in the list." });
  });

  it("removes a startup for good, keeping only what leaves it out of refreshes", async () => {
    const acme = await startup({ notes: "Private notes" });
    expect((await tool("remove_startup", { id: acme.id })).json).toMatchObject({ removed: "Acme", message: "Removed. Refreshes won't bring it back.", link: "https://dossier.example/startups" });
    expect(await prisma().startup.count()).toBe(0);
    expect(await prisma().startupBlock.count()).toBeGreaterThan(0);
    expect(await tool("remove_startup", { id: acme.id })).toMatchObject({ isError: true, text: "That startup is no longer in the list." });
  });
});

describe("the tools' hints", () => {
  it("marks reads as read-only, and what deletes or reaches out as such", async () => {
    const { tools } = (await call("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations ?? {}]));
    expect(hints.get_job_agent).toMatchObject({ readOnlyHint: true });
    expect(hints.list_startups).toMatchObject({ readOnlyHint: true });
    expect(hints.update_job_agent).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(hints.act_on_agent_find).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(hints.refresh_startups).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(hints.update_startup).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(hints.remove_startup).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
