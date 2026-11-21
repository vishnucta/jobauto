import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { needsYouHref } from "@/lib/dashboard";
import { loadDashboard } from "@/lib/dashboard-data";
import { loadWeeklyProgress } from "@/lib/insights-data";
import { saveSettings, loadSettings } from "@/lib/settings-data";
import { loadSetupSteps } from "@/lib/setup-checklist-data";
import { lastKnownTimeZone } from "@/lib/time-zone";
import { weekStatus } from "@/lib/weekly-target";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// get_today (jobauto fork), called as Claude calls it, through /api/mcp,
// against the test database with the demo data: the dashboard's Today's
// three, Needs you, the weekly target and Start here, from the same
// functions the dashboard draws.

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
const APP = "https://dossier.example";

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
    new Request(`${APP}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const body = await response.text();
  return JSON.parse(body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result;
}

/** Calls get_today; its answer, parsed. */
async function today(): Promise<{ isError: boolean; json: Record<string, unknown> & { todays_three: Record<string, unknown>[]; needs_you: Record<string, unknown>[] } }> {
  const result = await call("tools/call", { name: "get_today", arguments: {} });
  return { isError: result.isError ?? false, json: JSON.parse(result.content[0].text as string) };
}

/** A posting the agent found and scored: `covered` of 4 requirements (E32-2). */
const find = (externalId: string, covered: number, data: Record<string, unknown> = {}) =>
  prisma().agentCandidate.create({
    data: {
      source: "JSEARCH",
      externalId,
      dedupeKey: externalId,
      title: `Posting ${externalId}`,
      company: "Acme",
      url: `https://jobs.example/${externalId}`,
      score: covered * 25,
      covered,
      requirements: 4,
      mustMissing: 0,
      status: "SCORED",
      ...data,
    },
  });

describe("get_today", () => {
  it("only reads", async () => {
    const { tools } = (await call("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    expect(tools.find((entry) => entry.name === "get_today")?.annotations).toEqual({ readOnlyHint: true });
  });

  it("answers with Needs you as the dashboard draws it, each row with the link its button opens", async () => {
    const settings = await loadSettings();
    const expected = (await loadDashboard({ quietDays: settings.quietDays, timeZone: await lastKnownTimeZone() })).needsYou;
    expect(expected.length).toBeGreaterThan(0);

    const { isError, json } = await today();
    expect(isError).toBe(false);
    expect(json.needs_you).toEqual(
      expected.map((item) =>
        expect.objectContaining({ application_id: item.id, reason: item.reason, action: item.action, this_week: item.soon, link: `${APP}${needsYouHref(item)}` }),
      ),
    );
    expect(json.due_this_week).toBe(expected.filter((item) => item.soon).length);
    // The dashboard's line under the greeting, from Do today (jobauto fork).
    expect(json.summary).toEqual(expect.stringMatching(/needs? you this week|waiting|Nothing needs you/));
    expect(json.link).toBe(`${APP}/`);
    // The demo profile's levels are chosen, so scoring is on.
    expect(json).not.toHaveProperty("scoring_off");
  });

  it("puts her own drafts first in Today's three, then the agent's draft and its best match, with what acts on each", async () => {
    // Her drafts fill all three in the demo; without them the agent's come next.
    const newest = await prisma().application.findFirstOrThrow({ where: { status: "DRAFT", awaitingReview: false, archivedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true } });
    expect((await today()).json.todays_three[0]).toMatchObject({
      number: 1,
      what: "Your draft: finish it and send it",
      application_id: newest.id,
      link: `${APP}/applications/${newest.id}`,
    });
    await prisma().application.deleteMany({ where: { status: "DRAFT" } });

    const review = await prisma().application.create({ data: { origin: "AGENT", awaitingReview: true, title: "Analyst", company: "Acme" } });
    const drafted = await find("p1", 3, { status: "DRAFTED", applicationId: review.id, title: "Analyst" });
    const match = await find("p2", 4, { title: "Reporting Analyst" });
    await find("p3", 1, { title: "Long shot", skipReason: "BELOW_CUTOFF" });

    const { json } = await today();
    expect(json.todays_three).toEqual([
      {
        number: 1,
        what: "The agent's draft: read it and send it",
        title: "Analyst",
        company: "Acme",
        covered: "3 of 4",
        fit: "Strong fit",
        application_id: review.id,
        find_id: drafted.id,
        next: expect.stringContaining("act_on_agent_find approve"),
        link: `${APP}/applications/${review.id}`,
      },
      {
        number: 2,
        what: "A strong match: let the agent write the draft",
        title: "Reporting Analyst",
        company: "Acme",
        covered: "4 of 4",
        fit: "Strong fit",
        find_id: match.id,
        posting_url: "https://jobs.example/p2",
        next: expect.stringContaining("act_on_agent_find prepare_draft"),
        link: `${APP}/agent`,
      },
    ]);
  });

  it("tells the weekly target and how this week is going, as the This week card does", async () => {
    await saveSettings({ weeklyTarget: 0 });
    expect((await today()).json.weekly_target).toEqual({ target: 0, note: expect.stringContaining("sets one on the dashboard") });

    await saveSettings({ weeklyTarget: 5 });
    const week = await loadWeeklyProgress(await lastKnownTimeZone());
    expect((await today()).json.weekly_target).toEqual({ target: 5, sent_this_week: week.sent, status: weekStatus(week), weeks_in_a_row: week.streak });
  });

  it("lists Start here's steps not done yet, each with where it's done, and nothing once they all are", async () => {
    const steps = await loadSetupSteps();
    const open = steps.filter((step) => !step.done);
    expect(open.length).toBeGreaterThan(0);
    const { json } = await today();
    expect(json.start_here).toEqual({
      done: `${steps.length - open.length} of ${steps.length}`,
      steps: open.map((step) => ({ step: step.title, why: step.why, action: step.action, link: `${APP}${step.href.startsWith("#") ? `/${step.href}` : step.href}` })),
    });
  });

  it("says when nothing is waiting, and when scoring is off", async () => {
    await prisma().application.deleteMany({ where: { status: "DRAFT" } });
    const profile = await prisma().profile.findFirstOrThrow({ select: { id: true } });
    await prisma().profile.update({ where: { id: profile.id }, data: { levelFrom: null, levelTo: null } });

    const { json } = await today();
    expect(json.todays_three).toEqual([]);
    expect(json.nothing_waiting).toBe("Nothing is waiting. Run the job agent, or find a posting and start an application.");
    expect(json.scoring_off).toEqual({
      message: expect.stringMatching(/^Scoring is off: choose the levels your profile is for\. Until then no posting gets a score/),
      next: expect.stringContaining("set_profile_levels"),
      link: `${APP}/profile?section=target&profile=${profile.id}`,
    });
  });
});
