import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { companyKey } from "@/lib/network";
import { loadProfile } from "@/lib/profile-data";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The Recruiters tools (jobauto fork), called as Claude calls them, through
// /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const LINK = "https://dossier.example/recruiters";
const DAY = 86_400_000;

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z" });
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

const recruiter = (data: Record<string, unknown> = {}) => prisma().recruiter.create({ data: { name: "Hays", ...data } });

describe("the Recruiters tools", () => {
  it("say what to do first on an empty list, and add the suggested agencies once", async () => {
    expect((await tool("list_recruiters")).json).toMatchObject({
      counts: { all: 0, to_contact: 0, waiting: 0, replied: 0, due: 0 },
      next: expect.stringContaining("add_suggested_recruiters"),
      recruiters: [],
      link: LINK,
    });
    expect((await tool("add_suggested_recruiters")).json).toEqual({ added: 4, message: "Added 4 agencies.", link: LINK });
    expect((await tool("add_suggested_recruiters")).json).toEqual({ added: 0, message: "They're all on the list already.", link: LINK });
    expect((await tool("list_recruiters")).json).toMatchObject({ counts: { all: 4, to_contact: 4 } });
  });

  it("list due follow-ups first, filter by where each stands, and keep addresses and notes out of the list", async () => {
    const now = Date.now();
    await recruiter({ name: "Fresh", email: "fresh@agency.example", notes: "Private: asked for 90k" });
    await recruiter({ name: "Waiting", status: "CONTACTED", contactedAt: new Date(now - 2 * DAY), followUpAt: new Date(now + 5 * DAY) });
    await recruiter({ name: "Overdue", status: "CONTACTED", contactedAt: new Date(now - 9 * DAY), followUpAt: new Date(now - 2 * DAY) });
    await recruiter({ name: "Answered", status: "REPLIED", source: "found in search" });

    const list = await tool("list_recruiters");
    expect(list.json).toMatchObject({ counts: { all: 4, to_contact: 1, waiting: 2, replied: 1, due: 1 } });
    expect((list.json.recruiters as { name: string }[]).map((row) => row.name)).toEqual(["Overdue", "Fresh", "Waiting", "Answered"]);
    expect(list.json.recruiters).toMatchObject([
      { name: "Overdue", status: "CONTACTED", follow_up_due: true, next_step: "Contacted 9 days ago · follow-up due" },
      { name: "Fresh", status: "NOT_CONTACTED", has_email: true, has_notes: true, next_step: "Not contacted yet" },
      { name: "Waiting", status: "CONTACTED", next_step: expect.stringContaining("follow up in") },
      { name: "Answered", status: "REPLIED", found: "Found in a search" },
    ]);
    expect(list.text).not.toContain("fresh@agency.example");
    expect(list.text).not.toContain("asked for 90k");

    expect((await tool("list_recruiters", { filter: "due" })).json.recruiters).toMatchObject([{ name: "Overdue" }]);
    expect((await tool("list_recruiters", { filter: "to_contact" })).json.recruiters).toMatchObject([{ name: "Fresh" }]);
    expect((await tool("list_recruiters", { limit: 1 })).json.recruiters).toHaveLength(1);
  });

  it("read one whole, with its address, notes and history", async () => {
    const row = await recruiter({ email: "jobs@hays.example", notes: "Ask who the client is", events: { create: { text: "Added" } } });
    expect((await tool("list_recruiters", { id: row.id })).json).toMatchObject({
      id: row.id,
      name: "Hays",
      email: "jobs@hays.example",
      notes: "Ask who the client is",
      history: [{ text: "Added" }],
      link: LINK,
    });
    expect(await tool("list_recruiters", { id: "gone" })).toMatchObject({ isError: true, text: "That recruiter is no longer in the list." });
  });

  it("add one, trimmed, refuse a bad address or website, and not add the same agency twice", async () => {
    const added = await tool("add_recruiter", { name: "  Selby Jennings  ", contact_name: "Alex", website: "https://www.selbyjennings.com", speciality: "Finance" });
    expect(added.json).toMatchObject({ name: "Selby Jennings", contact_name: "Alex", website: "https://www.selbyjennings.com", status: "NOT_CONTACTED", message: "Added.", link: LINK });
    expect(await prisma().recruiter.findFirstOrThrow({ where: { name: "Selby Jennings" }, include: { events: true } })).toMatchObject({ source: "you", events: [{ text: "Added" }] });

    expect(await tool("add_recruiter", { name: "Hays", email: "not an address" })).toMatchObject({ isError: true, text: "That doesn't look like an email address." });
    expect(await tool("add_recruiter", { name: "Hays", website: "javascript:alert(1)" })).toMatchObject({ isError: true, text: "A website starts with https://" });
    const again = await tool("add_recruiter", { name: "selby jennings" });
    expect(again).toMatchObject({ isError: true, text: expect.stringContaining("already on the list") });
    expect(again.text).toContain("update_recruiter");
    expect(await prisma().recruiter.count()).toBe(1);
  });

  it("add a hiring manager or a referral, more than one person at the same employer, and keep the kind on an update", async () => {
    const manager = await tool("add_recruiter", { kind: "hiring_manager", name: "Nordbank", contact_name: "Anna Weber", speciality: "Regulatory Reporting" });
    expect(manager.json).toMatchObject({ kind: "hiring_manager", name: "Nordbank", contact_name: "Anna Weber" });
    expect((await tool("add_recruiter", { kind: "referral", name: "Nordbank", contact_name: "Sam", relation: "We worked together at EY" })).json).toMatchObject({ kind: "referral", how_you_know_them: "We worked together at EY" });
    expect(await tool("add_recruiter", { kind: "hiring_manager", name: "nordbank", contact_name: "anna weber" })).toMatchObject({ isError: true, text: expect.stringContaining("already on the list") });
    const id = (manager.json as unknown as { id: string }).id;
    expect((await tool("update_recruiter", { id, notes: "Met in Frankfurt" })).json).toMatchObject({ kind: "hiring_manager" });
  });

  it("add one the user removed before, which lifts the removal", async () => {
    const row = await recruiter();
    await tool("remove_recruiter", { id: row.id });
    expect(await prisma().recruiterBlock.count()).toBe(1);
    expect((await tool("add_recruiter", { name: "Hays" })).isError).toBe(false);
    expect(await prisma().recruiterBlock.count()).toBe(0);
  });

  it("change only what is given, clear a detail with an empty string, and refuse an empty change", async () => {
    const row = await recruiter({ contactName: "Alex", email: "jobs@hays.example", speciality: "Finance", notes: "Keep" });
    expect((await tool("update_recruiter", { id: row.id, speciality: "Banking", email: "" })).json).toMatchObject({ speciality: "Banking", contact_name: "Alex", has_email: false, notes: "Keep" });
    expect(await prisma().recruiter.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ speciality: "Banking", contactName: "Alex", email: "", notes: "Keep" });
    expect(await tool("update_recruiter", { id: row.id })).toMatchObject({ isError: true, text: expect.stringContaining("Say what to change") });
    expect(await tool("update_recruiter", { id: row.id, email: "nope" })).toMatchObject({ isError: true, text: "That doesn't look like an email address." });
    expect(await tool("update_recruiter", { id: row.id, name: " " })).toMatchObject({ isError: true, text: "Give the agency, recruiter or employer a name." });
    expect(await tool("update_recruiter", { id: "gone", notes: "x" })).toMatchObject({ isError: true, text: "That recruiter is no longer in the list." });
  });

  it("move the conversation on, start and stop the follow-up clock, and snooze only a recruiter being waited on", async () => {
    const row = await recruiter();
    expect(await tool("snooze_recruiter", { id: row.id })).toMatchObject({ isError: true, text: "Only a recruiter you're waiting to hear from can be snoozed." });

    const contacted = await tool("set_recruiter_status", { id: row.id, status: "CONTACTED" });
    expect(contacted.json).toMatchObject({ status: "CONTACTED", history: [{ text: "Marked as contacted" }], link: LINK });
    const stored = await prisma().recruiter.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.contactedAt).not.toBeNull();
    expect(stored.followUpAt!.getTime() - stored.contactedAt!.getTime()).toBe(7 * DAY);

    const snoozed = await tool("snooze_recruiter", { id: row.id });
    expect(snoozed.json).toMatchObject({ status: "CONTACTED", history: [{ text: "Marked as contacted" }, { text: "Snoozed for 3 days" }] });

    expect((await tool("set_recruiter_status", { id: row.id, status: "REPLIED" })).json).toMatchObject({ status: "REPLIED" });
    expect((await prisma().recruiter.findUniqueOrThrow({ where: { id: row.id } })).followUpAt).toBeNull();
    expect(await tool("snooze_recruiter", { id: row.id })).toMatchObject({ isError: true, text: "Only a recruiter you're waiting to hear from can be snoozed." });

    expect((await tool("set_recruiter_status", { id: row.id, status: "NOT_CONTACTED" })).json).toMatchObject({ status: "NOT_CONTACTED", next_step: "Not contacted yet" });
    expect(await tool("set_recruiter_status", { id: "gone", status: "CONTACTED" })).toMatchObject({ isError: true, text: "That recruiter is no longer in the list." });
    expect(await tool("snooze_recruiter", { id: "gone" })).toMatchObject({ isError: true, text: "That recruiter is no longer in the list." });
  });

  it("remove one and remember it, so a search doesn't put it back", async () => {
    const row = await recruiter({ events: { create: { text: "Added" } } });
    expect((await tool("remove_recruiter", { id: row.id })).json).toMatchObject({ removed: "Hays", link: LINK });
    expect(await prisma().recruiter.count()).toBe(0);
    expect(await prisma().recruiterBlock.count()).toBe(1);
    expect(await tool("remove_recruiter", { id: row.id })).toMatchObject({ isError: true, text: "That recruiter is no longer in the list." });
  });

  it("draft a first message from the profile, a follow-up once the user wrote, and send nothing", async () => {
    const { basics } = await loadProfile();
    const row = await recruiter({ contactName: "Alex", speciality: "Finance and accounting", email: "jobs@hays.example" });
    const first = await tool("draft_recruiter_message", { id: row.id });
    expect(first.json).toMatchObject({ recruiter: "Hays", kind: "first", has_email: true, link: LINK });
    expect(first.json.subject).toContain("Introduction:");
    expect(first.json.body).toContain("Hello Alex,");
    expect(first.json.body).toContain(basics.name);
    expect(first.json.body).toContain("finance and accounting");
    // The address is for the screen's Gmail button, not for what Claude reads.
    expect(first.text).not.toContain("jobs@hays.example");
    expect(first.text).not.toContain("mail.google.com");

    await tool("set_recruiter_status", { id: row.id, status: "CONTACTED" });
    const followUp = await tool("draft_recruiter_message", { id: row.id });
    expect(followUp.json).toMatchObject({ kind: "follow-up" });
    expect(followUp.json.subject).toContain("Following up:");
    expect((await tool("draft_recruiter_message", { id: row.id, kind: "first" })).json).toMatchObject({ kind: "first" });
    expect(await tool("draft_recruiter_message", { id: "gone" })).toMatchObject({ isError: true, text: "That recruiter is no longer in the list." });
  });
});

describe("the Recruiters tools' hints", () => {
  it("marks reads as read-only, and only the removal as destructive", async () => {
    const { tools } = (await call("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations ?? {}]));
    expect(hints.list_recruiters).toMatchObject({ readOnlyHint: true });
    expect(hints.draft_recruiter_message).toMatchObject({ readOnlyHint: true });
    for (const name of ["add_recruiter", "update_recruiter", "set_recruiter_status", "snooze_recruiter", "add_suggested_recruiters"]) {
      expect(hints[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    }
    expect(hints.remove_recruiter).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe("get_network_matches", () => {
  const person = (firstName: string, lastName: string, company: string, position: string) =>
    prisma().connection.create({ data: { firstName, lastName, company, position, url: `https://www.linkedin.com/in/${firstName.toLowerCase()}`, companyKey: companyKey(company) } });

  it("only reads", async () => {
    const { tools } = (await call("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    expect(tools.find((entry) => entry.name === "get_network_matches")?.annotations).toEqual({ readOnlyHint: true });
  });

  it("says when no connections are imported", async () => {
    expect((await tool("get_network_matches", { companies: ["Berenberg"] })).json).toEqual({
      imported: false,
      message: expect.stringContaining("Connections.csv"),
      link: LINK,
    });
  });

  it("counts the people the user knows at an employer, and names only those asked for a referral, who are on Recruiters", async () => {
    await person("Jane", "Doe", "Berenberg Bank GmbH & Co. KG", "Head of Finance");
    await person("Erika", "Mustermann", "Berenberg", "Regulatory Reporting Lead");
    await person("Max", "Mustermann", "Initech", "Controller");
    // Jane was asked for a referral on the screen: she's a contact now, as askForReferral adds her.
    const referral = await recruiter({ kind: "REFERRAL", name: "Berenberg Bank GmbH & Co. KG", contactName: "Jane Doe" });
    const application = await prisma().application.create({ data: { title: "Analyst", company: "Berenberg" } });
    const posting = await prisma().posting.create({ data: { source: "JSEARCH", externalId: "p1", title: "Analyst", company: "Acme AG" } });

    const answer = await tool("get_network_matches", { application_id: application.id, posting_id: posting.id, companies: ["Berenberg"] });
    expect(answer.json).toEqual({
      imported: true,
      employers: [
        { company: "Berenberg", people_you_know: 2, asked_for_referral: [{ id: referral.id, contact_name: "Jane Doe", status: expect.any(String) }] },
        { company: "Acme AG", people_you_know: 0 },
      ],
      next: expect.stringContaining("ask for a referral there"),
      link: `https://dossier.example/applications/${application.id}?tab=posting`,
    });
    // Who they are stays in Dossier: never the names, positions or profiles of the connections.
    for (const hidden of ["Erika", "Mustermann", "Head of Finance", "Regulatory Reporting Lead", "linkedin.com"]) expect(answer.text).not.toContain(hidden);
    expect((await tool("get_network_matches", { posting_id: posting.id })).json).toMatchObject({ link: "https://dossier.example/jobs" });
  });

  it("says what's missing", async () => {
    expect(await tool("get_network_matches")).toMatchObject({ isError: true, text: "Give application_id, posting_id or companies, with an employer's name." });
    expect(await tool("get_network_matches", { application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect(await tool("get_network_matches", { posting_id: "gone" })).toMatchObject({ isError: true, text: "That posting is no longer in Dossier." });
  });
});
