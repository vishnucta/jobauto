import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// What comes after applying (Dossier 1.15, jobauto fork): interview rounds,
// the offer, a drafted follow-up, the work sample and the day an application
// was sent, through the tools Claude calls, through /api/mcp, against the
// test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const fake = vi.hoisted(() => ({ ai: true }));
vi.mock("@/lib/ai/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/config")>()),
  isAiConfigured: async () => fake.ai,
  isAiUsable: async () => fake.ai,
}));
// The calendar's side is tested in src/lib/google; here it's off.
const calendar = vi.hoisted(() => ({
  sync: vi.fn<(id: string) => Promise<{ inCalendar: boolean; eventLink: string | null }>>(async () => ({ inCalendar: false, eventLink: null })),
}));
vi.mock("@/lib/google/availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google/availability")>()),
  syncInterviewToCalendar: calendar.sync,
}));
// Jobs are queued for real, but don't run.
vi.mock("@/lib/jobs/runner", async (importOriginal) => {
  const runner = await importOriginal<typeof import("@/lib/jobs/runner")>();
  return {
    ...runner,
    startJob: vi.fn(async (definition: { type: string }, input: object, options: { key?: string; applicationId?: string } = {}) => {
      const { prisma } = await import("@/lib/prisma");
      return (await prisma.job.create({ data: { type: definition.type, input, key: options.key, applicationId: options.applicationId } })).id;
    }),
  };
});

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

let token = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  // Times without an offset are read in the zone the browser last told the server.
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false, browserTimeZone: "Europe/Berlin" });
  fake.ai = true;
  calendar.sync.mockClear();
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

const application = (company: string) => prisma().application.findFirstOrThrow({ where: { company } });
const rounds = (applicationId: string) => prisma().interview.findMany({ where: { applicationId }, orderBy: { round: "asc" } });

describe("after applying (1.15)", () => {
  it("offers its tools, with hints that say what they change", async () => {
    const { tools } = (await rpc("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations]));
    // A date goes to Google Calendar when Dossier keeps interviews there, without invitations.
    expect(hints.update_interview_round).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(hints.update_offer).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    // Drafted only: nothing is sent.
    expect(hints.draft_follow_up).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(hints.get_work_sample).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(hints.write_work_sample).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  it("dates the round to come, gives it its details, and reads the rounds back", async () => {
    const northstar = await application("Northstar Health");
    const dated = await tool("update_interview_round", { id: northstar.id, at: "2027-03-04T14:00", minutes: 45, place: "Microsoft Teams", people: ["Erika Mustermann, Head of Finance"] });
    expect(dated.isError).toBe(false);
    expect(dated.json).toMatchObject({
      id: northstar.id,
      rounds: [{ round: 1, still_to_come: true, at: "2027-03-04T14:00:00+01:00", minutes: 45, place: "Microsoft Teams", people: ["Erika Mustermann, Head of Finance"] }],
      time_zone: "Europe/Berlin",
      link: `https://dossier.example/applications/${northstar.id}`,
    });
    expect(dated.json.next).toBeUndefined();
    // The date is the application's next interview too, as on the page, and the calendar is brought in step.
    expect((await prisma().application.findUniqueOrThrow({ where: { id: northstar.id } })).nextInterviewAt).toEqual(new Date("2027-03-04T13:00:00Z"));
    expect(calendar.sync).toHaveBeenCalledWith(northstar.id);

    // Only the fields given change.
    const [round] = await rounds(northstar.id);
    await tool("update_interview_round", { id: northstar.id, round_id: round.id, notes: "Ask about the team's reporting stack." });
    expect((await rounds(northstar.id))[0]).toMatchObject({ minutes: 45, place: "Microsoft Teams", people: "Erika Mustermann, Head of Finance", notes: "Ask about the team's reporting stack." });

    const read = await tool("get_application", { id: northstar.id });
    expect(read.json).toMatchObject({ interviews: [{ round_id: round.id, round: 1, notes: "Ask about the team's reporting stack." }], time_zone: "Europe/Berlin" });
  });

  it("starts the next round once every round is past, and keeps a past round's date", async () => {
    const northstar = await application("Northstar Health");
    await prisma().interview.create({ data: { applicationId: northstar.id, round: 1, at: new Date("2026-01-10T10:00:00Z"), notes: "Went well." } });
    const [first] = await rounds(northstar.id);
    expect(await tool("update_interview_round", { id: northstar.id, round_id: first.id, at: "2027-01-01T10:00" })).toMatchObject({
      isError: true,
      text: "Only the round still to come takes a date. Leave out round_id to set it.",
    });

    // Details without a round: the next round, as Add the next round makes it.
    const added = await tool("update_interview_round", { id: northstar.id, place: "Hamburg office" });
    expect(added.json).toMatchObject({ done: ["Added round 2.", "Round 2 saved."], rounds: [{ round: 1, notes: "Went well." }, { round: 2, still_to_come: true, at: null, place: "Hamburg office" }] });
    // A date then goes to that round, not a third.
    await tool("update_interview_round", { id: northstar.id, at: "2027-02-01T09:30:00+01:00" });
    expect((await rounds(northstar.id)).map((round) => [round.round, round.at?.toISOString() ?? null, round.place])).toEqual([
      [1, "2026-01-10T10:00:00.000Z", ""],
      [2, "2027-02-01T08:30:00.000Z", "Hamburg office"],
    ]);

    expect(await tool("update_interview_round", { id: northstar.id, round_id: "gone", notes: "x" })).toMatchObject({ isError: true });
    expect(await tool("update_interview_round", { id: northstar.id })).toMatchObject({ isError: true });
    expect(await tool("update_interview_round", { id: northstar.id, at: "next Tuesday" })).toMatchObject({ isError: true });
    expect(await tool("update_interview_round", { id: "gone", notes: "x" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("says the rounds show once the application is in Interview", async () => {
    const meridian = await application("Meridian Bank");
    const dated = await tool("update_interview_round", { id: meridian.id, at: "2027-03-04T14:00" });
    expect(dated.json.next).toContain("set_application_status");
  });

  it("saves the offer's details, changing only those given, and reads it back", async () => {
    const oaken = await application("Oaken Studio");
    const saved = await tool("update_offer", { id: oaken.id, salary: "€62,000 a year", decide_by: "2026-12-11", holidays: "30 days" });
    expect(saved.json).toMatchObject({ offer: { salary: "€62,000 a year", start_date: null, holidays: "30 days", office: "", decide_by: "2026-12-11" } });
    expect(saved.json.next).toBeUndefined();

    await tool("update_offer", { id: oaken.id, start_date: "2027-02-01", decide_by: null, office: "Hamburg, 3 days a week" });
    expect(await prisma().offer.findUniqueOrThrow({ where: { applicationId: oaken.id } })).toMatchObject({
      salary: "€62,000 a year",
      holidays: "30 days",
      office: "Hamburg, 3 days a week",
      startDate: new Date("2027-02-01T00:00:00Z"),
      decideBy: null,
    });
    expect((await tool("get_application", { id: oaken.id })).json).toMatchObject({ offer: { salary: "€62,000 a year", start_date: "2027-02-01", decide_by: null } });

    expect(await tool("update_offer", { id: oaken.id })).toMatchObject({ isError: true });
    expect(await tool("update_offer", { id: oaken.id, decide_by: "11.12.2026" })).toMatchObject({ isError: true });
    expect(await tool("update_offer", { id: "gone", salary: "€1" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("keeps a follow-up Claude wrote as the page's draft, without sending it or showing who it's to", async () => {
    const meridian = await application("Meridian Bank");
    const drafted = await tool("draft_follow_up", { id: meridian.id, subject: "Following up on my application", body: "Dear Ms Mustermann, ..." });
    expect(drafted.json).toMatchObject({ id: meridian.id, kind: "follow-up", drafted: true, link: `https://dossier.example/applications/${meridian.id}` });
    expect(drafted.json.replaced).toBeUndefined();
    expect((await prisma().application.findUniqueOrThrow({ where: { id: meridian.id } })).messageDraft).toMatchObject({
      kind: "follow-up",
      subject: "Following up on my application",
      body: "Dear Ms Mustermann, ...",
      writtenWith: "claude-chat",
    });
    expect(await prisma().job.count({ where: { type: "write-message" } })).toBe(0);

    // A draft there is handed back when it's replaced, so nothing changed by hand is lost unseen.
    await prisma().application.update({ where: { id: meridian.id }, data: { messageDraft: { kind: "follow-up", to: "jobs@meridian.example", subject: "Edited", body: "Edited by hand", writtenWith: "claude-chat", at: "2026-11-17T10:00:00.000Z" } } });
    const read = await tool("get_application", { id: meridian.id });
    expect(read.json).toMatchObject({ message_draft: { kind: "follow-up", what: "A follow-up", subject: "Edited", body: "Edited by hand", drafted: "2026-11-17" } });
    expect(read.text).not.toContain("jobs@meridian.example");
    const again = await tool("draft_follow_up", { id: meridian.id, subject: "Again", body: "Hello again" });
    expect(again.json.replaced).toEqual({ subject: "Edited", body: "Edited by hand" });

    expect(await tool("draft_follow_up", { id: meridian.id, subject: "Only a subject" })).toMatchObject({ isError: true });
  });

  it("has Dossier's AI draft it on request, and answers an offer only in Offer", async () => {
    const meridian = await application("Meridian Bank");
    const started = await tool("draft_follow_up", { id: meridian.id });
    expect(started.json).toMatchObject({ status: "started", task_id: expect.any(String), kind: "follow-up" });
    expect(await prisma().job.findUniqueOrThrow({ where: { id: started.json.task_id as string } })).toMatchObject({
      type: "write-message",
      key: `message:${meridian.id}`,
      input: { applicationId: meridian.id, kind: "follow-up" },
    });
    // One at a time, as on the page.
    expect(await tool("draft_follow_up", { id: meridian.id })).toMatchObject({ isError: true, text: "A message is being drafted already. Try again once it's done." });

    expect(await tool("draft_follow_up", { id: meridian.id, kind: "accept", subject: "Yes", body: "Gladly." })).toMatchObject({ isError: true });
    const oaken = await application("Oaken Studio");
    expect((await tool("draft_follow_up", { id: oaken.id, kind: "more", subject: "About the salary", body: "Could we talk about it?" })).json).toMatchObject({ kind: "more", drafted: true });

    fake.ai = false;
    const brightline = await application("Brightline Transit");
    expect((await tool("draft_follow_up", { id: brightline.id })).text).toContain("subject and body");
  });

  it("records the day an application was sent, then where it stands now", async () => {
    const brightline = await application("Brightline Transit");
    const moved = await tool("set_application_status", { id: brightline.id, status: "SCREENING", sent_on: "2026-10-02" });
    expect(moved.json).toMatchObject({ status: "Screening", changed: true, sent_on: "2026-10-02" });
    const after = await prisma().application.findUniqueOrThrow({ where: { id: brightline.id }, include: { events: { orderBy: { at: "asc" } } } });
    expect(after).toMatchObject({ status: "SCREENING", sentAt: new Date("2026-10-02T12:00:00Z") });
    expect(after.events.map((event) => [event.from, event.to])).toEqual([
      ["DRAFT", "SENT"],
      ["SENT", "SCREENING"],
    ]);
    expect((await tool("get_application", { id: brightline.id })).json).toMatchObject({ sent_on: "2026-10-02" });

    // Only once, and never ahead of time.
    expect((await tool("set_application_status", { id: brightline.id, status: "INTERVIEW", sent_on: "2026-10-05" })).text).toContain("marked sent on 2026-10-02 already");
    const ledgerly = await application("Ledgerly");
    expect(await tool("set_application_status", { id: ledgerly.id, status: "SENT", sent_on: "2099-01-01" })).toMatchObject({ isError: true });
    expect(await tool("set_application_status", { id: ledgerly.id, status: "DRAFT", sent_on: "2026-10-01" })).toMatchObject({ isError: true });
  });

  it("reads the work sample, and has Dossier write one", async () => {
    const ledgerly = await application("Ledgerly");
    expect(await tool("get_work_sample", { id: ledgerly.id })).toMatchObject({ isError: true, text: "This application has no work sample yet. write_work_sample writes one." });

    const started = await tool("write_work_sample", { id: ledgerly.id });
    expect(started.json).toMatchObject({ status: "started", task_id: expect.any(String), link: `https://dossier.example/applications/${ledgerly.id}?tab=sample` });
    // One being written is followed, not started twice.
    expect((await tool("write_work_sample", { id: ledgerly.id })).json).toMatchObject({ task_id: started.json.task_id, already_under_way: true });
    expect((await tool("get_work_sample", { id: ledgerly.id })).json).toMatchObject({ status: "being written", task_id: started.json.task_id });

    await prisma().job.deleteMany();
    const sample = {
      title: "My first 90 days as Financial Analyst at Ledgerly",
      situation: "Monthly reporting runs late.",
      phases: [{ heading: "Days 1-30", steps: ["Learn the close calendar"] }],
      proof: ["Ran the monthly close at Northwind Logistics"],
      closing: "I'd start with the close.",
      unverified: ["Northwind Logistics"],
      inMappe: true,
    };
    await prisma().application.update({ where: { id: ledgerly.id }, data: { workSample: sample } });
    expect((await tool("get_work_sample", { id: ledgerly.id })).json).toMatchObject({
      title: sample.title,
      phases: sample.phases,
      proof: sample.proof,
      check_these: ["Northwind Logistics"],
      in_bewerbungsmappe: true,
    });
    expect((await tool("get_application", { id: ledgerly.id })).json).toMatchObject({ work_sample: "get_work_sample reads it" });

    fake.ai = false;
    expect(await tool("write_work_sample", { id: ledgerly.id })).toMatchObject({ isError: true });
    expect(await tool("write_work_sample", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });
});
