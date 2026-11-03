import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { cancelJob, retryJob } from "@/lib/jobs/runner";
import { savePosting } from "@/lib/postings";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The task tools (jobauto fork), called as Claude calls them, through
// /api/mcp, against the test database with the demo data.

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "s".repeat(40), DOSSIER_PASSWORD: "argon2id:m=19456,t=2,p=1:c2FsdA:aGFzaA" } }));
vi.mock("@/lib/ai/config", () => ({ isAiUsable: async () => false, isAiConfigured: async () => false }));
// Nothing runs here: a task retried waits in the queue, and one cancelled while queued ends at once.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  retryJob: vi.fn(async (id: string) => (await db.client!.job.updateMany({ where: { id, status: "FAILED" }, data: { status: "QUEUED", error: null } })).count > 0),
  cancelJob: vi.fn(async (id: string) => {
    await db.client!.job.updateMany({ where: { id, status: "QUEUED" }, data: { status: "FAILED", error: "Cancelled." } });
  }),
}));

import { POST } from "@/app/api/mcp/route";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

const posting = {
  source: "JSEARCH" as const,
  externalId: "p1",
  title: "Product Designer",
  company: "Acme",
  place: "Berlin",
  remote: null,
  salary: "",
  postedAt: null,
  url: "https://jobs.example/p1",
  via: "",
  description: "Product Designer: Figma, design systems.",
  complete: true,
};

let token = "";
let applicationId = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  vi.mocked(retryJob).mockClear();
  vi.mocked(cancelJob).mockClear();
  applicationId = (await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).id;
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

/** A task as the runner leaves it: done, unless `status` says otherwise. */
const task = (type: string, data: Partial<Prisma.JobUncheckedCreateInput> = {}) => prisma().job.create({ data: { type, status: "DONE", input: {}, ...data } });

/** What check_task tells about a task. */
const check = async (id: string) => (await tool("check_task", { task_id: id })).json;

describe("the task tools", () => {
  it("follows a task while it waits, runs and fails, and retries and cancels it", async () => {
    const draft = await task("connector-draft", { status: "QUEUED", input: { posting: "Designer at Acme", postingUrl: "", note: "", postingId: null } });
    expect(await check(draft.id)).toMatchObject({ task_id: draft.id, task: "Drafting an application", status: "queued", next: expect.stringContaining("waiting") });
    await prisma().job.update({ where: { id: draft.id }, data: { status: "RUNNING", step: "Writing the cover letter" } });
    expect(await check(draft.id)).toMatchObject({ status: "working", step: "Writing the cover letter", next: "Check again in a little while." });
    await prisma().job.update({ where: { id: draft.id }, data: { status: "FAILED", error: "The model didn't answer." } });
    expect(await check(draft.id)).toMatchObject({ status: "failed", error: "The model didn't answer.", next: "retry_task runs it again." });

    expect((await tool("retry_task", { task_id: draft.id })).json).toEqual({ task_id: draft.id, status: "started", next: "Call check_task with this task_id until it's done." });
    expect(retryJob).toHaveBeenCalledWith(draft.id);
    expect(await tool("retry_task", { task_id: draft.id })).toMatchObject({ isError: true, text: "This can't be retried: it's still running or already done." });

    expect((await tool("cancel_task", { task_id: draft.id })).json).toEqual({ task_id: draft.id, status: "cancelled" });
    expect(cancelJob).toHaveBeenCalledWith(draft.id);
    expect(await prisma().job.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "FAILED", error: "Cancelled." });
    expect(await tool("cancel_task", { task_id: draft.id })).toMatchObject({ isError: true, text: expect.stringContaining("already finished") });

    const running = await task("zip-pdfs", { status: "RUNNING", step: "Rendered 2 of 4" });
    expect((await tool("cancel_task", { task_id: running.id })).json).toMatchObject({ task_id: running.id, status: "stopping" });

    for (const name of ["check_task", "cancel_task", "retry_task"]) {
      expect(await tool(name, { task_id: "gone" })).toMatchObject({ isError: true, text: expect.stringMatching(/^There's no such task\./) });
    }
  });

  it("never runs an apply run again, since one from Claude must not press Send", async () => {
    const run = await task("apply", { status: "FAILED", error: "Cancelled.", input: { applicationId, attemptId: "attempt-1" } });
    expect(await check(run.id)).toMatchObject({ application_id: applicationId, run_id: "attempt-1", status: "failed", next: "Start a new apply run with start_apply." });
    expect(await tool("retry_task", { task_id: run.id })).toMatchObject({ isError: true, text: "An apply run can't be run again from here. Start a new apply run with start_apply." });
    expect(retryJob).not.toHaveBeenCalled();
  });

  it("has a failed answer to an email drafted anew, since running it again wouldn't check the email", async () => {
    const again = "Draft it again with draft_email_reply, which checks the email first.";
    const reply = await task("draft-reply", { status: "FAILED", error: "The model didn't answer.", input: { emailId: "email-1", note: "", slots: null } });
    expect(await check(reply.id)).toMatchObject({ email_id: "email-1", status: "failed", error: "The model didn't answer.", next: again });
    expect(await tool("retry_task", { task_id: reply.id })).toMatchObject({ isError: true, text: again });
    expect(retryJob).not.toHaveBeenCalled();
    expect(await prisma().job.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ status: "FAILED" });
  });

  it("tells what came of each kind of task in ids and links, without documents' texts or contact details", async () => {
    const app = (tab = "") => `https://dossier.example/applications/${applicationId}${tab}`;
    const unit = (id: string, text: string) => ({ id, label: id, text });

    const read = await task("read-posting", {
      input: { posting: "Designer at Acme" },
      result: {
        extracted: { title: null, company: "Acme", role: "Designer", location: "Berlin", mode: null, salary: null, deadline: null, requirements: [], asksForReferences: false, language: null },
        extractedWith: "extract@1",
        match: {
          items: [
            { requirement: "Figma", result: "covered", skill: "Figma", experienceIds: [], note: null },
            { requirement: "Go", result: "gap", skill: null, experienceIds: [], note: null },
          ],
        },
        matchedWith: "match@1",
      },
    });
    expect(await check(read.id)).toMatchObject({ task: "Reading a posting for New application", status: "done", result: { company: "Acme", role: "Designer", matched: "1 of 2 requirements" }, link: "https://dossier.example/new" });

    const written = await task("write-documents", {
      applicationId,
      result: { resume: [unit("summary", "SECRET RESUME TEXT")], resumeWith: "r@1", letter: [unit("paragraph:1", "SECRET LETTER TEXT")], letterWith: "l@1" },
    });
    const writtenTold = await tool("check_task", { task_id: written.id });
    expect(writtenTold.json).toMatchObject({ application_id: applicationId, status: "done", link: app() });
    expect(writtenTold.text).not.toContain("SECRET");

    const rewrite = await task("regenerate-unit", {
      input: { applicationId, document: "COVER_LETTER", unitId: "paragraph:1", from: "SECRET OLD TEXT" },
      result: { outcome: "rewritten", previous: unit("paragraph:1", "SECRET OLD TEXT"), unit: unit("paragraph:1", "SECRET NEW TEXT") },
    });
    const rewriteTold = await tool("check_task", { task_id: rewrite.id });
    expect(rewriteTold.json).toMatchObject({ task: "Rewriting part of a document", application_id: applicationId, result: { outcome: "Rewritten" }, link: app("?tab=letter"), next: "Read it with get_document." });
    expect(rewriteTold.text).not.toContain("SECRET");

    const refine = await task("refine", {
      input: { applicationId, messageId: "m1", request: "Shorter, please", target: null, viewing: null },
      result: { messageId: "m2", edited: [{ document: "RESUME", unitId: "summary" }] },
    });
    expect(await check(refine.id)).toMatchObject({ task: "Answering in Refine with AI", result: { parts_changed: 1 }, link: app(), next: "Read the changes with get_document." });

    const translated = await task("translate-documents", {
      input: { applicationId, language: "German" },
      result: { language: "German", rewritten: 9, left: ["SECRET GREETING"] },
    });
    const translatedTold = await tool("check_task", { task_id: translated.id });
    expect(translatedTold.json).toMatchObject({
      task: "Rewriting the documents in German",
      application_id: applicationId,
      result: { parts_rewritten: 9, parts_left_as_they_were: 1 },
      link: app(),
      next: expect.stringContaining("get_document"),
    });
    // Counts and links only: not the names of the parts, which can be a document's own words.
    expect(translatedTold.text).not.toContain("SECRET");

    const email = await task("write-email", { input: { applicationId }, result: { units: [unit("to", "hr@acme.example"), unit("body", "SECRET EMAIL")], previous: null } });
    const emailTold = await tool("check_task", { task_id: email.id });
    expect(emailTold.json).toMatchObject({ application_id: applicationId, link: app("?tab=email"), next: "Read it with get_document, document email." });
    expect(emailTold.text).not.toMatch(/hr@acme|SECRET/);

    const zip = await task("zip-pdfs", { result: { file: "zip-1.zip", fileName: "dossier-pdfs-2026-10-31.zip", documents: 4 } });
    expect(await check(zip.id)).toMatchObject({
      result: { documents: 4, file_name: "dossier-pdfs-2026-10-31.zip" },
      link: `https://dossier.example/api/downloads/${zip.id}`,
      next: expect.stringContaining("downloads the zip once"),
    });
    expect((await check(zip.id)).result).not.toHaveProperty("file");

    const resume = await task("import-profile", { input: { resume: "Jane Doe, jane@example.com, +49 30 1234" }, result: { profile: { basics: { email: "jane@example.com" } }, readWith: "x@1" } });
    const resumeTold = await tool("check_task", { task_id: resume.id });
    expect(resumeTold.json).toMatchObject({
      task: "Reading a resume for the profile",
      link: `https://dossier.example/profile/import?job=${resume.id}`,
      next: "Nothing is in the profile yet. Show the user what was read with finish_profile_import.",
    });
    expect(resumeTold.text).not.toMatch(/jane@example|1234/);

    const reply = await task("draft-reply", {
      input: { emailId: "email-1", note: "", slots: null },
      result: { body: "Dear Ms Weber, SECRET REPLY", gaps: [], unverified: [], slots: ["2026-11-02T09:00:00.000Z"] },
    });
    const replyTold = await tool("check_task", { task_id: reply.id });
    expect(replyTold.json).toMatchObject({ email_id: "email-1", result: { offered_times: ["2026-11-02T09:00:00.000Z"] }, link: "https://dossier.example/inbox" });
    expect(replyTold.text).not.toContain("SECRET");

    const scan = await task("agent-scan", { input: { manual: true }, result: { found: 10, fresh: 4, scored: 4, drafted: 1, skipped: 6, message: "Found 4 new postings." } });
    expect(await check(scan.id)).toMatchObject({ task: "Running the job agent", result: { found: 10, drafted: 1, message: "Found 4 new postings." }, link: "https://dossier.example/agent" });

    const agentDraft = await task("agent-draft", { input: { candidateId: "candidate-1" }, result: { applicationId } });
    expect(await check(agentDraft.id)).toMatchObject({ candidate_id: "candidate-1", result: { application_id: applicationId }, link: "https://dossier.example/agent" });

    await savePosting(posting);
    const score = await task("posting-score", { input: { posting }, result: { score: 82, reasons: ["Led a design system"], redFlags: [] } });
    expect(await check(score.id)).toMatchObject({
      task: "Scoring a posting",
      posting: "Product Designer at Acme",
      result: { score: 82, band: "Good fit", reasons: ["Led a design system"], red_flags: [] },
      link: "https://dossier.example/jobs?view=saved",
    });

    const startups = await task("startups-refresh", {
      result: {
        at: "2026-10-31T09:00:00.000Z",
        added: 3,
        sources: [
          { source: "YC", found: 5, error: null },
          { source: "HN", found: 0, error: "Hacker News didn't answer." },
        ],
        emailsFound: 1,
      },
    });
    expect(await check(startups.id)).toMatchObject({
      result: { added: 3, emails_found: 1, sources: [{ source: "Y Combinator", found: 5 }, { source: "Hacker News", found: 0, error: "Hacker News didn't answer." }] },
      link: "https://dossier.example/startups",
    });

    const drafted = await task("connector-draft", { input: { posting: "Designer at Acme", postingUrl: "", note: "", postingId: null }, result: { applicationId } });
    expect(await check(drafted.id)).toMatchObject({ result: { application_id: applicationId }, link: app() });

    const apply = await task("apply", {
      input: { applicationId, attemptId: "attempt-1" },
      result: { attemptId: "attempt-1", status: "FAILED", note: "This posting asks for applications by email (jobs@acme.example). Use the Email tab instead." },
    });
    expect(await check(apply.id)).toMatchObject({
      application_id: applicationId,
      run_id: "attempt-1",
      result: { outcome: "FAILED", note: "This posting asks for applications by email (address left out). Use the Email tab instead." },
      link: app("?tab=apply"),
    });

    expect(await check((await task("something-new")).id)).toMatchObject({ task: "Background work", status: "done" });
  });

  it("knows every kind of task the runner runs", async () => {
    await import("@/lib/jobs/definitions");
    const { definitions } = (globalThis as unknown as { jobRunner: { definitions: Map<string, unknown> } }).jobRunner;
    expect(definitions.size).toBeGreaterThanOrEqual(14);
    for (const type of definitions.keys()) {
      const queued = await task(type, { status: "QUEUED" });
      expect(await check(queued.id), type).toMatchObject({ status: "queued" });
      expect((await check(queued.id)).task, type).not.toBe("Background work");
    }
  });
});
