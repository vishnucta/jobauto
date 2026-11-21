import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FALLBACK } from "@/lib/call-prep";
import { startJob } from "@/lib/jobs/runner";
import { PRACTICE_JOB_KEY } from "@/lib/jobs/prepare-practice";
import { EMPTY_QUERY } from "@/lib/job-search/search";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// Interview practice and the salary guide (jobauto fork), called as Claude
// calls them, through /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
const fake = vi.hoisted(() => ({ aiUsable: true }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => fake.aiUsable, isAiConfigured: async () => fake.aiUsable }));
// Nothing is prepared here: the job only starts.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "practice-job"),
}));

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
  fake.aiUsable = true;
  vi.mocked(startJob).mockClear();
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

/** Calls a tool; its text answer, parsed when it's JSON, and whether it's an error. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; json: Record<string, unknown> }> {
  const result = await call("tools/call", { name, arguments: args });
  const text = result.content[0].text as string;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A plain message.
  }
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> };
}

const PACK = {
  questions: [{ question: { de: "Erzählen Sie etwas über sich.", en: "Tell us about yourself." }, answer: { de: "Ich bin Analystin.", en: "I'm an analyst." } }],
  salary: { de: "Ich stelle mir […] vor.", en: "I'm thinking of […]." },
  stories: [],
  toAsk: [{ de: "Wie groß ist das Team?", en: "How big is the team?" }],
  gaps: ["What is your notice period?"],
  unverified: [],
};

/** A posting a search found, with the salary it states. */
const seen = (externalId: string, title: string, salary: string) => ({
  source: "ARBEITSAGENTUR",
  externalId,
  title,
  company: "Acme",
  place: "Hamburg",
  remote: null,
  salary,
  postedAt: null,
  url: "",
  via: "",
  description: "",
  complete: false,
});

describe("Interview practice through the Claude connector", () => {
  it("marks reading as read-only and preparing as a change", async () => {
    const { tools } = (await call("tools/list", {})) as { tools: { name: string; annotations?: Record<string, boolean> }[] };
    const hints = Object.fromEntries(tools.map((entry) => [entry.name, entry.annotations]));
    expect(hints.get_practice_prep).toEqual({ readOnlyHint: true });
    expect(hints.prepare_practice).toEqual({ readOnlyHint: false, openWorldHint: false });
    expect(hints.get_salary_guide).toEqual({ readOnlyHint: true });
  });

  it("says there's no pack yet, prepares one, and follows one under way rather than starting another", async () => {
    expect((await tool("get_practice_prep")).json).toEqual({
      prepared: false,
      message: "There's no practice pack yet. prepare_practice prepares one.",
      link: `${APP}/call-prep`,
    });

    expect((await tool("prepare_practice")).json).toMatchObject({ task_id: "practice-job", status: "started" });
    expect(startJob).toHaveBeenCalledTimes(1);

    const running = await prisma().job.create({ data: { type: "prepare-practice", key: PRACTICE_JOB_KEY, status: "RUNNING", input: {} } });
    expect((await tool("prepare_practice")).json).toMatchObject({ task_id: running.id, note: "It was already being prepared: this is that task." });
    expect(startJob).toHaveBeenCalledTimes(1);
    expect((await tool("get_practice_prep")).json).toMatchObject({ prepared: false, task_id: running.id });
  });

  it("reads the pack, with the sentences for when German runs out", async () => {
    await saveSettings({ practicePrep: PACK });
    expect((await tool("get_practice_prep")).json).toEqual({ prepared: true, when_german_runs_out: FALLBACK, to_hear_it_again: expect.any(Object), ...PACK, link: `${APP}/call-prep` });
  });

  it("needs Dossier's own AI to prepare it", async () => {
    fake.aiUsable = false;
    expect(await tool("prepare_practice")).toMatchObject({ isError: true, text: expect.stringContaining("Settings → AI provider") });
    expect(startJob).not.toHaveBeenCalled();
  });
});

describe("The salary guide through the Claude connector", () => {
  it("answers for a title, an application or a posting, from what the postings seen pay", async () => {
    await prisma().postingSearch.create({
      data: {
        query: EMPTY_QUERY,
        postings: [
          seen("a", "Regulatory Reporting Analyst", "55.000 € bis 65.000 € pro Jahr"),
          seen("b", "Reporting Analyst", "65.000 € pro Jahr"),
          seen("c", "Regulatory Reporting Specialist", "EUR 70,000–80,000"),
        ],
        found: 3,
      },
    });
    const guide = { title: "Regulatory Reporting Analyst", guide: expect.stringMatching(/^€\d{2},000–€\d{2},000 a year \(middle €65,000\), from 3 jobs like this one$/), middle: 65_000, from_postings: 3, basis: "jobs like this one" };
    expect((await tool("get_salary_guide", { title: "Regulatory Reporting Analyst" })).json).toMatchObject({ ...guide, link: `${APP}/jobs` });

    const application = await prisma().application.create({ data: { title: "Acme", role: "Regulatory Reporting Analyst", company: "Acme" } });
    expect((await tool("get_salary_guide", { application_id: application.id })).json).toMatchObject({ ...guide, link: `${APP}/applications/${application.id}?tab=apply` });

    const posting = await prisma().posting.create({ data: { source: "ARBEITSAGENTUR", externalId: "a", title: "Regulatory Reporting Analyst", salary: "55.000 € bis 65.000 € pro Jahr" } });
    expect((await tool("get_salary_guide", { posting_id: posting.id })).json).toMatchObject(guide);
  });

  it("says when too few postings state a salary, and what's missing", async () => {
    expect((await tool("get_salary_guide", { title: "Regulatory Reporting Analyst" })).json).toMatchObject({ guide: null, message: expect.stringContaining("Fewer than 3 postings") });
    expect(await tool("get_salary_guide")).toMatchObject({ isError: true, text: "Give application_id, posting_id or a job title." });
    expect(await tool("get_salary_guide", { application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect(await tool("get_salary_guide", { posting_id: "gone" })).toMatchObject({ isError: true, text: "That posting is no longer in Dossier." });
  });
});
