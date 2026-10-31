import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLY_ANSWERS } from "@/lib/apply/answers";
import { addWatch, isWatching, stopWatchingAll } from "@/lib/apply/watches";
import { applyJob } from "@/lib/jobs/apply";
import { startJob } from "@/lib/jobs/runner";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The Apply tab's tools (jobauto fork), called as Claude calls them, through
// /api/mcp, against the test database with the demo data. No browser opens:
// starting a run only queues its job, and startJob is mocked.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "apply-job"),
}));
// The other groups of tools are left out: these tests are about the Apply tab's.
vi.mock("@/lib/connector/tools/agent", () => ({ registerAgentTools: () => {} }));
vi.mock("@/lib/connector/tools/applications", () => ({ registerApplicationTools: () => {} }));
vi.mock("@/lib/connector/tools/documents", () => ({ registerDocumentTools: () => {} }));
vi.mock("@/lib/connector/tools/inbox", () => ({ registerInboxTools: () => {} }));
vi.mock("@/lib/connector/tools/postings", () => ({ registerPostingTools: () => {} }));
vi.mock("@/lib/connector/tools/profile", () => ({ registerProfileTools: () => {} }));
vi.mock("@/lib/connector/tools/settings", () => ({ registerSettingsTools: () => {} }));
vi.mock("@/lib/connector/tools/tasks", () => ({ registerTaskTools: () => {} }));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const PERSONIO = "https://ledgerly.jobs.personio.de/job/42";

let token = "";
/** The demo's Ledgerly draft, which has a resume and a cover letter. */
let ledgerly = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  vi.mocked(startJob).mockClear();
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
  ledgerly = (await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).id;
});
afterEach(() => stopWatchingAll());
afterAll(() => prisma().$disconnect());

/** Sends one request to /api/mcp, as Claude does; its result. */
async function rpc(method: string, params: Record<string, unknown> = {}) {
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

/** Ledgerly's form, on a Personio page: a system simple enough that the app's own runs may press Send. */
const onPersonio = () => prisma().application.update({ where: { id: ledgerly }, data: { postingUrl: PERSONIO } });
/** A run of the apply assistant for Ledgerly. */
const run = (data: { status?: "OPENING" | "WAITING" | "SUBMITTED" | "ABANDONED" | "FAILED"; note?: string; filled?: object[]; unfilled?: object[]; screenshot?: boolean; startedAt?: Date } = {}) =>
  prisma().applyAttempt.create({ data: { applicationId: ledgerly, url: PERSONIO, ats: "personio", ...data } });
/** The apply job, still going, for a run. */
const going = (attemptId: string) =>
  prisma().job.create({ data: { type: "apply", key: `apply:${ledgerly}`, applicationId: ledgerly, status: "RUNNING", input: { applicationId: ledgerly, attemptId } } });
/** The server watching a run's browser tab for the confirmation. */
const watch = (attemptId: string) => addWatch(attemptId, { page: {} as Page, timer: setInterval(() => {}, 60_000) });

describe("the Apply tab's tools in the Claude connector", () => {
  it("says where the form is, what the profile lacks, the answers without the address, and how each run went", async () => {
    await onPersonio();
    await prisma().profileField.deleteMany({ where: { key: "phone" } });
    await saveSettings({ applyAnswers: { ...DEFAULT_APPLY_ANSWERS, salary: "60.000 € brutto/Jahr", street: "Musterstraße 12", postalCode: "20095" } });
    const earlier = await run({ status: "FAILED", note: "The page couldn't be opened.", startedAt: new Date("2026-10-22T09:00:00Z") });
    const latest = await run({
      status: "WAITING",
      note: "Filled in as far as I could.",
      filled: [
        { label: "E-Mail", what: "Email address", value: "" },
        { label: "Vorname", what: "First name", value: "Jane" },
        { label: "Warum Ledgerly?", what: "Written by the AI", value: "x".repeat(400), byAi: true },
      ],
      unfilled: [{ label: "Gehaltsvorstellung", required: true, reason: "no answer saved" }],
      screenshot: true,
      startedAt: new Date("2026-10-23T08:00:00Z"),
    });

    const status = await tool("get_apply_status", { id: ledgerly });
    expect(status.json).toMatchObject({
      id: ledgerly,
      application_status: "Draft",
      form: { where: "web page", url: PERSONIO, host: "ledgerly.jobs.personio.de", system: "Personio", sign_in_needed: false, job_board: false },
      has_resume: true,
      has_cover_letter: true,
      profile_missing: ["phone number"],
      answers: { salary: "60.000 € brutto/Jahr", start_date: "", street_saved: true, postal_code_saved: true, german_level: "A2", press_send: false },
      link: `https://dossier.example/applications/${ledgerly}?tab=apply`,
    });
    expect(status.text).not.toContain("Musterstraße");
    expect(status.text).not.toContain("20095");
    expect(status.json.running_task_id).toBeUndefined();

    const [shown, before] = status.json.runs as Record<string, unknown>[];
    expect(shown).toMatchObject({
      run_id: latest.id,
      status: "Waiting for the user",
      note: "Filled in as far as I could.",
      started: expect.any(String),
      page: "ledgerly.jobs.personio.de",
      left_to_user: [{ field: "Gehaltsvorstellung", required: true, reason: "no answer saved" }],
      check_ai_answers: "Dossier's AI wrote an answer to the form's own questions: the user reads it in the browser window before sending.",
      screenshot: `https://dossier.example/api/apply/${latest.id}/filled`,
      next: expect.stringContaining("isn't watching"),
    });
    expect(shown.filled).toEqual([
      { field: "E-Mail", filled_with: "Email address" },
      { field: "Vorname", filled_with: "First name", value: "Jane" },
      { field: "Warum Ledgerly?", filled_with: "Written by the AI", value: `${"x".repeat(300)}…`, by_ai: true },
    ]);
    expect(before).toMatchObject({ run_id: earlier.id, status: "Didn't work", note: "The page couldn't be opened." });
    expect(before.next).toBeUndefined();

    watch(latest.id);
    expect(((await tool("get_apply_status", { id: ledgerly })).json.runs as Record<string, unknown>[])[0].next).toContain("notices the confirmation");
  });

  it("points to the Email tab or to applying by hand when there's no form, and follows a run still filling one in", async () => {
    await prisma().application.update({ where: { id: ledgerly }, data: { postingText: "Send your application to bewerbung@ledgerly.nl." } });
    expect((await tool("get_apply_status", { id: ledgerly })).json.form).toMatchObject({ where: "email", to: "bewerbung@ledgerly.nl", next: expect.stringContaining("Email tab") });
    await prisma().application.update({ where: { id: ledgerly }, data: { postingText: "No address here." } });
    expect((await tool("get_apply_status", { id: ledgerly })).json.form).toMatchObject({ where: "none", next: expect.stringContaining("apply by hand") });

    await onPersonio();
    const filling = await run();
    const job = await going(filling.id);
    expect((await tool("get_apply_status", { id: ledgerly })).json).toMatchObject({
      running_task_id: job.id,
      runs: [{ run_id: filling.id, status: "Working on it", next: expect.stringContaining("check_task") }],
    });
    expect(await tool("get_apply_status", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("starts a run that never presses Send, whatever the saved answers say", async () => {
    await onPersonio();
    await saveSettings({ applyAnswers: { ...DEFAULT_APPLY_ANSWERS, autoSubmit: true } });
    const started = await tool("start_apply", { id: ledgerly });
    expect(started.json).toMatchObject({
      task_id: "apply-job",
      status: "started",
      run_id: expect.any(String),
      link: `https://dossier.example/applications/${ledgerly}?tab=apply`,
      next: expect.stringContaining("check_task"),
    });
    expect(started.json.already_running).toBeUndefined();
    const attempt = await prisma().applyAttempt.findUniqueOrThrow({ where: { id: started.json.run_id as string } });
    expect(attempt).toMatchObject({ applicationId: ledgerly, url: PERSONIO, ats: "personio", status: "OPENING", autoSubmit: false });
    expect(startJob).toHaveBeenCalledWith(applyJob, { applicationId: ledgerly, attemptId: attempt.id }, { key: `apply:${ledgerly}`, applicationId: ledgerly });
  });

  it("follows a run that's going, waits for the user on one she has open, and replaces one left from a restart", async () => {
    await onPersonio();
    const first = await run();
    const job = await going(first.id);
    const followed = await tool("start_apply", { id: ledgerly });
    expect(followed.json).toMatchObject({ task_id: job.id, run_id: first.id, already_running: true });
    expect(followed.json.presses_send).toBeUndefined();
    // Started on the Apply tab, where the user let runs press Send: Claude hears so.
    await prisma().applyAttempt.update({ where: { id: first.id }, data: { autoSubmit: true } });
    expect((await tool("start_apply", { id: ledgerly })).json.presses_send).toContain("started on the Apply tab");
    expect(startJob).not.toHaveBeenCalled();

    await prisma().job.update({ where: { id: job.id }, data: { status: "DONE" } });
    await prisma().applyAttempt.update({ where: { id: first.id }, data: { status: "WAITING" } });
    watch(first.id);
    const refused = await tool("start_apply", { id: ledgerly });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`run_id ${first.id}`);
    expect(refused.text).toContain("settle_apply");
    expect(startJob).not.toHaveBeenCalled();

    stopWatchingAll();
    expect((await tool("start_apply", { id: ledgerly })).json).toMatchObject({ task_id: "apply-job", status: "started" });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ status: "ABANDONED", note: "A new run replaced this one." });
    expect(startJob).toHaveBeenCalledTimes(1);
  });

  it("starts nothing without a form to fill or a resume to attach", async () => {
    expect(await tool("start_apply", { id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect(await tool("start_apply", { id: ledgerly })).toMatchObject({ isError: true, text: "There's no link to apply at. Add the posting's link on the Job posting tab first." });
    await prisma().application.update({ where: { id: ledgerly }, data: { postingText: "Send your application to bewerbung@ledgerly.nl." } });
    expect(await tool("start_apply", { id: ledgerly })).toMatchObject({ isError: true, text: "This posting asks for applications by email (bewerbung@ledgerly.nl). Use the Email tab." });
    await onPersonio();
    await prisma().document.deleteMany({ where: { applicationId: ledgerly, kind: "RESUME" } });
    expect(await tool("start_apply", { id: ledgerly })).toMatchObject({ isError: true, text: "This application has no resume to attach yet." });
    expect(startJob).not.toHaveBeenCalled();
    expect(await prisma().applyAttempt.count()).toBe(0);
  });

  it("settles a run by the user's word, moving a draft to Sent", async () => {
    await onPersonio();
    const waiting = await run({ status: "WAITING" });
    watch(waiting.id);
    expect((await tool("settle_apply", { run_id: waiting.id, sent: true })).json).toEqual({
      run_id: waiting.id,
      status: "Sent",
      application_id: ledgerly,
      application_status: "Sent",
      link: `https://dossier.example/applications/${ledgerly}?tab=apply`,
    });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "SUBMITTED", note: "Sent, as you said.", finishedAt: expect.any(Date) });
    expect(isWatching(waiting.id)).toBe(false);
    expect((await prisma().application.findUniqueOrThrow({ where: { id: ledgerly } })).status).toBe("SENT");

    const another = await run({ status: "WAITING" });
    expect((await tool("settle_apply", { run_id: another.id, sent: false })).json).toMatchObject({ status: "Not sent", application_status: "Sent" });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: another.id } })).toMatchObject({ status: "ABANDONED", note: "Not sent, as you said." });

    expect(await tool("settle_apply", { run_id: "gone", sent: true })).toMatchObject({ isError: true, text: "That run no longer exists." });
    const filling = await run();
    await going(filling.id);
    expect(await tool("settle_apply", { run_id: filling.id, sent: true })).toMatchObject({ isError: true, text: expect.stringContaining("still filling in the form") });
    expect((await prisma().applyAttempt.findUniqueOrThrow({ where: { id: filling.id } })).status).toBe("OPENING");
  });

  it("leaves a run that already ended as it ended", async () => {
    await onPersonio();
    const events = await prisma().statusEvent.count({ where: { applicationId: ledgerly } });
    const confirmed = await run({ status: "SUBMITTED", note: "Sent: the page confirmed your application." });
    expect(await tool("settle_apply", { run_id: confirmed.id, sent: false })).toMatchObject({
      isError: true,
      text: "That run already ended: Sent. To change the application's status, use set_application_status.",
    });
    const failed = await run({ status: "FAILED", note: "The page couldn't be opened." });
    expect(await tool("settle_apply", { run_id: failed.id, sent: true })).toMatchObject({ isError: true, text: expect.stringContaining("already ended: Didn't work.") });
    const closed = await run({ status: "ABANDONED", note: "The browser tab was closed before I saw a confirmation." });
    expect(await tool("settle_apply", { run_id: closed.id, sent: true })).toMatchObject({ isError: true, text: expect.stringContaining("already ended: Not sent.") });

    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: confirmed.id } })).toMatchObject({ status: "SUBMITTED", note: "Sent: the page confirmed your application." });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "FAILED", note: "The page couldn't be opened." });
    expect(await prisma().applyAttempt.findUniqueOrThrow({ where: { id: closed.id } })).toMatchObject({ status: "ABANDONED", note: "The browser tab was closed before I saw a confirmation." });
    expect((await prisma().application.findUniqueOrThrow({ where: { id: ledgerly } })).status).toBe("DRAFT");
    expect(await prisma().statusEvent.count({ where: { applicationId: ledgerly } })).toBe(events);
  });

  it("approves a job agent draft waiting for review once the user says she sent it", async () => {
    await onPersonio();
    await prisma().application.update({ where: { id: ledgerly }, data: { awaitingReview: true } });
    const draft = await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "agent-1", dedupeKey: "agent-1", status: "DRAFTED", applicationId: ledgerly } });

    // Not sent: it stays with the job agent for the user to review.
    const first = await run({ status: "WAITING" });
    expect((await tool("settle_apply", { run_id: first.id, sent: false })).json).toMatchObject({ status: "Not sent", application_status: "Draft" });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: ledgerly } })).toMatchObject({ status: "DRAFT", awaitingReview: true });
    expect((await prisma().agentCandidate.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFTED");

    const second = await run({ status: "WAITING" });
    expect((await tool("settle_apply", { run_id: second.id, sent: true })).json).toMatchObject({ status: "Sent", application_status: "Sent" });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: ledgerly } })).toMatchObject({ status: "SENT", awaitingReview: false });
    expect((await prisma().agentCandidate.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("APPROVED");
  });

  it("saves the standard answers given, keeping the rest", async () => {
    const saved = await tool("save_apply_answers", { salary: "60.000 € brutto/Jahr", german_level: "B2", street: "Musterstraße 12", press_send: true, id: ledgerly });
    expect(saved.json).toMatchObject({
      answers: { salary: "60.000 € brutto/Jahr", german_level: "B2", english_level: "C1", work_permit: true, street_saved: true, postal_code_saved: false, press_send: true },
      note: expect.stringContaining("runs started from Claude never do"),
      link: `https://dossier.example/applications/${ledgerly}?tab=apply`,
    });
    expect(saved.text).not.toContain("Musterstraße");
    expect((await loadSettings()).applyAnswers).toEqual({ ...DEFAULT_APPLY_ANSWERS, salary: "60.000 € brutto/Jahr", germanLevel: "B2", street: "Musterstraße 12", autoSubmit: true });

    const again = await tool("save_apply_answers", { salary: "", notice_period: " 3 Monate zum Monatsende ", work_permit: false });
    expect(again.json).toMatchObject({ answers: { salary: "", notice_period: "3 Monate zum Monatsende", work_permit: false, german_level: "B2", press_send: true }, link: "https://dossier.example/applications" });

    expect(await tool("save_apply_answers", { id: ledgerly })).toMatchObject({ isError: true, text: "Give at least one answer to save." });
    expect(await tool("save_apply_answers", { german_level: "fluent" })).toMatchObject({ isError: true });
    expect(await tool("save_apply_answers", { postal_code: "1".repeat(13) })).toMatchObject({ isError: true });
    expect((await loadSettings()).applyAnswers).toMatchObject({ germanLevel: "B2", postalCode: "", noticePeriod: "3 Monate zum Monatsende" });
  });

  it("lists the tools with what they do to the world, and says a run Claude starts leaves Send to the user", async () => {
    const { tools } = (await rpc("tools/list")) as { tools: { name: string; description: string; annotations: Record<string, boolean> }[] };
    const listed = (name: string) => tools.find((entry) => entry.name === name);
    expect(listed("get_apply_status")?.annotations).toEqual({ readOnlyHint: true });
    expect(listed("start_apply")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(listed("start_apply")?.description).toContain("leaves Send to the user");
    expect(listed("settle_apply")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(listed("save_apply_answers")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });
});
