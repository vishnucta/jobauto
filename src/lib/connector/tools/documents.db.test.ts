import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { demoProfile, demoResumeUnits } from "@/lib/demo-profile";
import { documentLabels, ENGLISH_LABELS, type DocumentLabels } from "@/lib/document-labels";
import { resumeContent, type ResumeContent } from "@/lib/resume-content";
import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";
import { pdfWith } from "@/test/resume-files";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../prisma/seed/demo";

import { challengeOf, exchangeCode, issueCode, registerClient } from "../oauth";

// The connector's document tools (jobauto fork), called as Claude calls
// them, through /api/mcp, against the test database with the demo data.

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
  isAiUsable: async () => fake.ai,
  isAiConfigured: async () => fake.ai,
}));
// Jobs are queued for real, but don't run.
vi.mock("@/lib/jobs/runner", async (importOriginal) => {
  const runner = await importOriginal<typeof import("@/lib/jobs/runner")>();
  return {
    ...runner,
    startJob: vi.fn(async (definition: { type: string }, input: object, options: { key?: string; applicationId?: string }) => {
      const { prisma } = await import("@/lib/prisma");
      return (await prisma.job.create({ data: { type: definition.type, input, key: options.key, applicationId: options.applicationId } })).id;
    }),
  };
});
// Printing needs Chromium: here it hands over a small PDF of two pages.
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF");
vi.mock("@/lib/pdf/render", () => ({ renderPdf: vi.fn(async () => PDF) }));

import { POST } from "@/app/api/mcp/route";
import { renderPdf } from "@/lib/pdf/render";

const prisma = () => db.client!;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

type Part = { id: string; label: string; text: string; check?: string[]; unverified?: string[]; revision?: string; rewriting?: boolean };

let token = "";
let id = "";
beforeEach(async () => {
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now: new Date("2026-10-23T09:00:00Z") });
  await saveSettings({ connectorEnabledAt: "2026-10-23T09:00:00.000Z", strict: false });
  fake.ai = true;
  const clientId = await registerClient({ name: "Claude", redirectUris: [CLAUDE] });
  const verifier = "v".repeat(50);
  const code = await issueCode({ clientId, redirectUri: CLAUDE, codeChallenge: challengeOf(verifier), resource: "" });
  token = (await exchangeCode({ code, clientId, redirectUri: CLAUDE, verifier })).access_token;
  id = (await prisma().application.findFirstOrThrow({ where: { company: "Ledgerly" } })).id;
});
afterAll(() => prisma().$disconnect());

/** Calls a tool; its text answer, parsed when it's JSON, whether it's an error, and all it answered. */
async function tool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; json: Record<string, unknown> & { parts: Part[] }; content: Record<string, unknown>[] }> {
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
  return { isError: result.isError ?? false, text, json: json as Record<string, unknown> & { parts: Part[] }, content: result.content };
}

const units = async (kind: "RESUME" | "COVER_LETTER" = "RESUME") =>
  (await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: id, kind } } })).units as Part[];
const summaryText = async () => (await units()).find((unit) => unit.id === "summary")!.text;
/** The revision get_document shows for a part, which a change names. */
const revision = async (document: "resume" | "cover_letter" | "email", partId: string) =>
  (await tool("get_document", { application_id: id, document })).json.parts.find((part) => part.id === partId)!.revision;
const PRIVATE = "The letter's sender and signature hold contact details, so they're changed on the application's page in Dossier.";

type CheckLine = { id: string; level: "ok" | "warn" | "fail"; title: string; detail?: string; fix?: Record<string, unknown> };
type RequirementLine = { index: number; requirement: string; named: boolean; in_profile: boolean; skill: string | null };
type Report = {
  document: string;
  file_name: string;
  pages: number;
  max_pages: number | null;
  reads: CheckLine[];
  requirements: { named: number; total: number; items: RequirementLine[] } | null;
  text: CheckLine[];
  checked_at: string;
  link: string;
};
/** The ATS check's answer, as check_resume writes it. */
const report = (answer: { json: unknown }) => answer.json as Report;

/** The resume's lines as its PDF reads back, in one column and in ASCII (the test PDF's Helvetica has no en dash or middle dot). */
function resumeLines(content: ResumeContent, labels: DocumentLabels = ENGLISH_LABELS): string[] {
  const section = (heading: string, lines: string[]) => (lines.length > 0 ? [heading, ...lines] : []);
  const dated = (title: string, at: string, dates: string, bullets: string[]) => [`${title}, ${at} ${dates}`, ...bullets];
  return [
    content.name,
    content.headline,
    content.contacts.join("  -  "),
    ...section(labels.profile, content.summary ? [content.summary] : []),
    ...section(labels.experience, content.experience.flatMap((role) => dated(role.role, role.company, role.dates, role.bullets))),
    ...section(labels.projects, content.projects.flatMap((project) => dated(project.name, project.link, project.dates, project.bullets))),
    ...section(labels.education, content.education.map((degree) => `${degree.degree}, ${degree.school} ${degree.dates}`)),
    ...section(labels.publications, content.publications.map((publication) => publication.citation)),
    ...section(labels.references, content.references.flatMap((reference) => [reference.name, reference.role, reference.contact])),
    ...section(labels.skills, content.skills ? [content.skills] : []),
    ...section(labels.languages, content.languages ? [content.languages] : []),
  ].map((line) => line.replace(/[^\x20-\x7e]/g, "-"));
}

describe("the connector's document tools", () => {
  it("reads a document as its tab shows it, without the letter's sender and signature", async () => {
    const resume = await tool("get_document", { application_id: id, document: "resume" });
    expect(resume.json).toMatchObject({
      application_id: id,
      document: "resume",
      look: { theme: "Editorial", theme_id: "editorial", photo: "no photo in the profile", themes: expect.arrayContaining(["Editorial", "Classic", "Modern"]) },
      versions: [],
      link: `https://dossier.example/applications/${id}`,
    });
    expect(resume.json.parts[0]).toEqual({ id: "summary", label: "Summary", text: await summaryText(), revision: expect.stringMatching(/^[0-9a-f]{8}$/) });

    const letter = await tool("get_document", { application_id: id, document: "cover_letter" });
    const ids = letter.json.parts.map((part) => part.id);
    // An older letter only shows its frame, drawn from the profile (E8-11).
    expect(ids.slice(0, 3)).toEqual(["date", "recipient", "greeting"]);
    expect(ids).toContain("paragraph:1");
    expect(ids).not.toContain("sender");
    expect(ids).not.toContain("signature");
    expect(letter.text).not.toContain("jane.doe@example.com");
    expect(letter.text).not.toContain("+31 6 1234 5678");
    expect(letter.json).toMatchObject({ look: { theme: "Editorial" }, link: `https://dossier.example/applications/${id}?tab=letter` });

    expect(await tool("get_document", { application_id: id, document: "email" })).toMatchObject({ isError: true, text: "This application has no email yet." });
    expect(await tool("get_document", { application_id: "gone", document: "resume" })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("never shows or changes a letter's stored sender and signature, nor those of its versions", async () => {
    const letter = await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: id, kind: "COVER_LETTER" } } });
    const stored = [
      { id: "sender", label: "Sender", text: "Jane Doe\njane.stored@example.com · +49 151 2345 6789 · Lindenstraße 5, 10969 Berlin" },
      ...(letter.units as Part[]),
      { id: "signature", label: "Signature", text: "Jane M. Doe" },
    ];
    await prisma().document.update({ where: { id: letter.id }, data: { units: stored } });
    const version = await prisma().documentVersion.create({ data: { documentId: letter.id, units: stored, cause: "WRITTEN" } });
    const [jobs, messages] = await Promise.all([prisma().job.count(), prisma().chatMessage.count()]);

    const now = await tool("get_document", { application_id: id, document: "cover_letter" });
    const then = await tool("get_document", { application_id: id, document: "cover_letter", version_id: version.id });
    expect(then.json.version).toMatchObject({ id: version.id, made: "Written by the AI" });
    for (const read of [now, then]) {
      const ids = read.json.parts.map((part) => part.id);
      expect(ids).toContain("paragraph:1");
      expect(ids).not.toContain("sender");
      expect(ids).not.toContain("signature");
      for (const detail of ["jane.stored@example.com", "+49 151 2345 6789", "Lindenstraße", "Jane M. Doe"]) expect(read.text).not.toContain(detail);
    }

    for (const part_id of ["sender", "signature"]) {
      const change = { application_id: id, document: "cover_letter", action: "change", part_id, revision: "0badc0de", text: "Someone else" };
      expect(await tool("edit_document", change)).toMatchObject({ isError: true, text: PRIVATE });
      expect(await tool("rewrite_document", { application_id: id, document: "cover_letter", part_id })).toMatchObject({ isError: true, text: PRIVATE });
      expect(await tool("rewrite_document", { application_id: id, document: "cover_letter", part_id, instruction: "Add my LinkedIn" })).toMatchObject({ isError: true, text: PRIVATE });
    }
    // Nor are they among the parts a refusal names.
    const unknown = await tool("edit_document", { application_id: id, document: "cover_letter", action: "change", part_id: "paragraph:99", text: "Hi" });
    expect(unknown.text).toMatch(/^There's no part "paragraph:99" in the cover letter\. Its parts are date, recipient, greeting, paragraph:1/);
    expect(unknown.text).not.toMatch(/sender|signature/);
    expect(await units("COVER_LETTER")).toEqual(stored);
    expect(await Promise.all([prisma().job.count(), prisma().chatMessage.count()])).toEqual([jobs, messages]);
  });

  it("changes a part, marks what the profile doesn't back, and leaves the sender alone", async () => {
    const before = await summaryText();
    const changed = await tool("edit_document", {
      application_id: id,
      document: "resume",
      action: "change",
      part_id: "summary",
      revision: await revision("resume", "summary"),
      text: "  Calm, clear tools.  ",
    });
    expect(changed.json).toMatchObject({ changed: "Summary", part_id: "summary", text: "Calm, clear tools.", was: before });
    expect((await units())[0]).toEqual({ id: "summary", label: "Summary", text: "Calm, clear tools." });

    // With "Never invent experience" on, Claude's text is checked as the chat's edits are.
    await saveSettings({ strict: true });
    // The answer has the part's new revision, to change it again.
    const guarded = await tool("edit_document", {
      application_id: id,
      document: "resume",
      action: "change",
      part_id: "summary",
      revision: changed.json.revision,
      text: "Product designer who shipped Globex's checkout.",
    });
    expect(guarded.json.check_these).toContain("Globex");
    expect((await units())[0]).toMatchObject({ unverified: expect.arrayContaining(["Globex"]) });
    expect((await tool("get_document", { application_id: id, document: "resume" })).json.parts[0].check).toContain("Globex");

    // A part an older letter only shows is stored when it's first changed.
    const greeting = await revision("cover_letter", "greeting");
    await tool("edit_document", { application_id: id, document: "cover_letter", action: "change", part_id: "greeting", revision: greeting, text: "Hello Ledgerly team," });
    expect((await units("COVER_LETTER"))[0]).toEqual({ id: "greeting", label: "Greeting", text: "Hello Ledgerly team," });

    expect(await tool("edit_document", { application_id: id, document: "cover_letter", action: "change", part_id: "sender", text: "Jane" })).toMatchObject({
      isError: true,
      text: "The letter's sender and signature hold contact details, so they're changed on the application's page in Dossier.",
    });
    expect((await tool("edit_document", { application_id: id, document: "resume", action: "change", part_id: "experience:nope", text: "Hi" })).text).toMatch(
      /^There's no part "experience:nope" in the resume\. Its parts are summary, experience:/,
    );
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "change", part_id: "summary", text: " " })).toMatchObject({
      isError: true,
      text: "Give the part's new text. To take it off the resume, use action leave_out.",
    });
  });

  it("leaves a part as it is when it changed since Claude read it, or while Dossier's AI rewrites it", async () => {
    const change = (args: Record<string, unknown>) => tool("edit_document", { application_id: id, document: "resume", action: "change", part_id: "summary", ...args });
    const read = await revision("resume", "summary");
    expect(await change({ text: "Claude's summary." })).toMatchObject({
      isError: true,
      text: "Give the revision get_document shows for the summary, so a change made since you read it isn't overwritten.",
    });

    // Meanwhile the user fixes the summary by hand on the page.
    await prisma().document.update({
      where: { applicationId_kind: { applicationId: id, kind: "RESUME" } },
      data: { units: [{ id: "summary", label: "Summary", text: "Fixed by hand." }, ...(await units()).slice(1)] },
    });
    expect(await change({ revision: read, text: "Claude's summary." })).toMatchObject({
      isError: true,
      text: "The summary changed since you read it, so nothing was saved. Read it again with get_document and change the new version.",
    });
    expect(await summaryText()).toBe("Fixed by hand.");
    const again = await change({ revision: await revision("resume", "summary"), text: "Claude's summary." });
    expect(again.json).toMatchObject({ text: "Claude's summary.", was: "Fixed by hand.", revision: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(again.json.revision).not.toBe(read);

    // As on the page, a part Dossier's AI is writing again can't be changed or left out until it's done.
    expect((await tool("rewrite_document", { application_id: id, document: "resume", part_id: "summary" })).json).toMatchObject({ status: "started" });
    const busy = "Dossier's AI is writing the summary again right now. Try again once get_document no longer shows it as rewriting.";
    expect(await change({ revision: again.json.revision, text: "Mine." })).toMatchObject({ isError: true, text: busy });
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "leave_out", part_id: "summary" })).toMatchObject({ isError: true, text: busy });
    expect(await summaryText()).toBe("Claude's summary.");
  });

  it("leaves a part of the resume out and puts it back", async () => {
    const summary = await summaryText();
    expect((await tool("edit_document", { application_id: id, document: "resume", action: "leave_out", part_id: "summary" })).json).toMatchObject({ left_out: "Summary", index: 0 });
    const read = await tool("get_document", { application_id: id, document: "resume" });
    expect(read.json.parts.map((part) => part.id)).not.toContain("summary");
    expect(read.json.left_out).toEqual([{ index: 0, what: "Summary", why: "left out by hand", text: summary }]);

    expect((await tool("edit_document", { application_id: id, document: "resume", action: "put_back", index: 0 })).json).toEqual({
      put_back: "Summary",
      link: `https://dossier.example/applications/${id}`,
    });
    expect((await units())[0].id).toBe("summary");
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "put_back", index: 0 })).toMatchObject({ isError: true, text: "Nothing is left out of this resume." });
    expect(await tool("edit_document", { application_id: id, document: "cover_letter", action: "leave_out", part_id: "paragraph:1" })).toMatchObject({
      isError: true,
      text: "Only a part of the resume can be left out.",
    });
  });

  it("reads and brings back a saved version, keeping the one it had", async () => {
    const document = await prisma().document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: id, kind: "RESUME" } } });
    const written = await prisma().documentVersion.create({
      data: { documentId: document.id, units: document.units as object[], cause: "WRITTEN", createdAt: new Date("2026-10-20T08:00:00Z") },
    });
    const summary = await summaryText();
    await tool("edit_document", { application_id: id, document: "resume", action: "change", part_id: "summary", revision: await revision("resume", "summary"), text: "By hand." });

    expect((await tool("get_document", { application_id: id, document: "resume" })).json.versions).toEqual([
      { id: written.id, at: "2026-10-20T08:00:00.000Z", made: "Written by the AI" },
    ]);
    const old = await tool("get_document", { application_id: id, document: "resume", version_id: written.id });
    expect(old.json).toMatchObject({ version: { id: written.id, made: "Written by the AI" }, next: expect.stringContaining("restore_version") });
    expect(old.json.parts[0]).toMatchObject({ id: "summary", text: summary });

    expect((await tool("edit_document", { application_id: id, document: "resume", action: "restore_version", version_id: written.id })).json).toMatchObject({ restored: "the resume" });
    expect(await summaryText()).toBe(summary);
    const versions = (await tool("get_document", { application_id: id, document: "resume" })).json.versions as { made: string }[];
    expect(versions.map((version) => version.made)).toEqual(["Brought back the version from 2026-10-20T08:00:00.000Z", "As it was before a restore", "Written by the AI"]);

    expect(await tool("edit_document", { application_id: id, document: "resume", action: "restore_version", version_id: written.id })).toMatchObject({
      isError: true,
      text: "That's the version you have now.",
    });
    expect(await tool("edit_document", { application_id: id, document: "cover_letter", action: "restore_version", version_id: written.id })).toMatchObject({
      isError: true,
      text: "There's no such version of the cover letter. Call get_document to see its versions.",
    });
    expect(await tool("get_document", { application_id: id, document: "resume", version_id: "gone" })).toMatchObject({ isError: true });
  });

  it("has Dossier's AI write the documents in another language, and says when it can't", async () => {
    fake.ai = false;
    expect(await tool("rewrite_in_language", { application_id: id, language: "German" })).toMatchObject({
      isError: true,
      text: "That needs an AI provider. Choose one in Settings → AI provider.",
    });
    fake.ai = true;
    expect(await tool("rewrite_in_language", { application_id: id, language: "Klingon" })).toMatchObject({ isError: true, text: expect.stringContaining("Dossier doesn't know the language") });
    expect(await tool("rewrite_in_language", { application_id: "gone", language: "German" })).toMatchObject({ isError: true, text: "That application no longer exists." });

    const started = await tool("rewrite_in_language", { application_id: id, language: "German" });
    expect(started.json).toMatchObject({ task_id: expect.any(String), status: "started", changing: "the resume, cover letter and email, to German", next: expect.stringContaining("check_task") });
    expect(await prisma().job.findUniqueOrThrow({ where: { id: started.json.task_id as string } })).toMatchObject({
      type: "translate-documents",
      key: `language:${id}`,
      applicationId: id,
      input: { applicationId: id, language: "German" },
    });
    // One at a time: asking again says so, rather than starting a second.
    expect(await tool("rewrite_in_language", { application_id: id, language: "Dutch" })).toMatchObject({
      isError: true,
      text: "Dossier is still rewriting this application. Try again when it's done.",
    });
    expect(await prisma().job.count({ where: { type: "translate-documents" } })).toBe(1);
  });

  it("has Dossier's AI rewrite a part, and undoes the rewrite", async () => {
    fake.ai = false;
    expect((await tool("rewrite_document", { application_id: id, document: "resume", part_id: "summary" })).text).toBe(
      "Dossier has no AI model of its own set up. Write the new text yourself and save it with edit_document.",
    );
    fake.ai = true;

    const started = await tool("rewrite_document", { application_id: id, document: "resume", part_id: "summary" });
    expect(started.json).toMatchObject({ task_id: expect.any(String), status: "started", rewriting: "the summary", next: expect.stringContaining("check_task") });
    const taskId = started.json.task_id as string;
    expect(await prisma().job.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      type: "regenerate-unit",
      applicationId: id,
      input: { applicationId: id, document: "RESUME", unitId: "summary", from: await summaryText() },
    });
    // Asking again follows the rewrite under way, and the page shows it.
    expect((await tool("rewrite_document", { application_id: id, document: "resume", part_id: "summary" })).json.task_id).toBe(taskId);
    expect((await tool("get_document", { application_id: id, document: "resume" })).json.parts[0]).toMatchObject({ id: "summary", rewriting: true });
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "undo", task_id: taskId })).toMatchObject({
      isError: true,
      text: "That rewrite isn't done yet. Call check_task until it is.",
    });

    // The rewrite finished: the summary has its new text, and the job what it replaced.
    const summary = (await units())[0];
    const rewritten = { ...summary, text: "A new summary." };
    await prisma().document.update({
      where: { applicationId_kind: { applicationId: id, kind: "RESUME" } },
      data: { units: [rewritten, ...(await units()).slice(1)] },
    });
    await prisma().job.update({ where: { id: taskId }, data: { status: "DONE", result: { outcome: "rewritten", previous: summary, unit: rewritten } } });
    expect((await tool("edit_document", { application_id: id, document: "resume", action: "undo", task_id: taskId })).json).toMatchObject({
      undone: "the rewrite of the summary",
      part_id: "summary",
      text: summary.text,
    });
    expect(await summaryText()).toBe(summary.text);
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "undo", task_id: taskId })).toMatchObject({
      isError: true,
      text: "It's been changed again since, so this can't be undone.",
    });
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "undo", task_id: "gone" })).toMatchObject({ isError: true });
  });

  it("only rewrites the parts the AI writes, storing a letter part that was only shown", async () => {
    const publication = (await units()).find((unit) => unit.id.startsWith("publication:"))!;
    expect(await tool("rewrite_document", { application_id: id, document: "resume", part_id: publication.id })).toMatchObject({
      isError: true,
      text: "A publication stays as the user wrote it. Change it with edit_document instead.",
    });
    expect(await tool("rewrite_document", { application_id: id, document: "cover_letter", part_id: "date" })).toMatchObject({
      isError: true,
      text: "This part isn't written by the AI. Change it with edit_document instead.",
    });
    expect(await tool("rewrite_document", { application_id: id, document: "resume" })).toMatchObject({
      isError: true,
      text: "Give part_id to write one part again, or an instruction to change the whole document.",
    });
    // As on the page, the chat only changes parts the letter stores.
    expect(await tool("rewrite_document", { application_id: id, document: "cover_letter", part_id: "greeting", instruction: "Warmer" })).toMatchObject({
      isError: true,
      text: "Dossier's chat can't change the greeting yet. Rewrite it without an instruction, or change it with edit_document.",
    });

    const greeting = await tool("rewrite_document", { application_id: id, document: "cover_letter", part_id: "greeting" });
    expect(greeting.json).toMatchObject({ status: "started", rewriting: "the greeting" });
    expect((await units("COVER_LETTER"))[0]).toMatchObject({ id: "greeting", label: "Greeting" });
  });

  it("changes a whole document through Dossier's chat, and undoes the last change", async () => {
    const chat = await tool("rewrite_document", { application_id: id, document: "resume", instruction: " Shorter, please " });
    expect(chat.json).toMatchObject({ status: "started", changing: "the resume" });
    const taskId = chat.json.task_id as string;
    expect(await prisma().job.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      type: "refine",
      applicationId: id,
      input: { request: "Shorter, please", viewing: "RESUME", target: null },
    });
    expect(await prisma().chatMessage.findFirst({ where: { applicationId: id, role: "USER" } })).toMatchObject({ text: "Shorter, please" });
    expect(await tool("rewrite_document", { application_id: id, document: "resume", part_id: "summary", instruction: "Longer" })).toMatchObject({
      isError: true,
      text: "I'm still working on your last message. Send this one when I'm done.",
    });

    // The reply shortened the summary.
    const summary = await summaryText();
    await prisma().document.update({
      where: { applicationId_kind: { applicationId: id, kind: "RESUME" } },
      data: { units: [{ id: "summary", label: "Summary", text: "Short." }, ...(await units()).slice(1)] },
    });
    const reply = await prisma().chatMessage.create({
      data: { applicationId: id, role: "AI", text: "I shortened the summary.", writtenWith: "test", edits: [{ document: "RESUME", unitId: "summary", text: "Short.", previousText: summary }] },
    });
    await prisma().job.update({ where: { id: taskId }, data: { status: "DONE", result: { messageId: reply.id, edited: [{ document: "RESUME", unitId: "summary" }] } } });
    expect((await tool("get_document", { application_id: id, document: "resume" })).json.last_chat_reply).toMatchObject({ text: "I shortened the summary.", parts_changed: 1 });

    expect((await tool("edit_document", { application_id: id, document: "resume", action: "undo", task_id: taskId })).json).toMatchObject({
      undone: "the change from Dossier's chat",
      parts: [{ document: "resume", part_id: "summary" }],
    });
    expect(await summaryText()).toBe(summary);
    // Without a task, the last change from the chat: that one, already undone.
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "undo" })).toMatchObject({ isError: true, text: "That's already undone." });
  });

  it("reads and changes the email, and says what's missing from an edit", async () => {
    await prisma().document.create({
      data: {
        applicationId: id,
        kind: "EMAIL",
        units: [
          { id: "to", label: "Recipient", text: "jobs@ledgerly.example" },
          { id: "subject", label: "Subject", text: "Application" },
          { id: "body", label: "Message", text: "Dear Ledgerly team,\n\nHello." },
        ],
      },
    });
    const email = await tool("get_document", { application_id: id, document: "email" });
    expect(email.json.parts.map((part) => part.id)).toEqual(["to", "subject", "body"]);
    expect(email.json.look).toBeUndefined();
    expect(email.json.link).toBe(`https://dossier.example/applications/${id}?tab=email`);
    // The recipient may be left empty, for the mail app to fill in.
    const to = email.json.parts[0].revision;
    expect((await tool("edit_document", { application_id: id, document: "email", action: "change", part_id: "to", revision: to, text: "" })).json).toMatchObject({ text: "", was: "jobs@ledgerly.example" });
    expect(await tool("rewrite_document", { application_id: id, document: "email", part_id: "to" })).toMatchObject({ isError: true, text: "This part isn't written by the AI. Change it with edit_document instead." });

    const edit = (args: Record<string, unknown>) => tool("edit_document", { application_id: id, document: "resume", ...args });
    expect(await edit({ action: "change", part_id: "summary" })).toMatchObject({ isError: true, text: "Give the part_id and the part's new text." });
    expect(await edit({ action: "leave_out" })).toMatchObject({ isError: true, text: "Give the part_id of the part to leave out." });
    expect(await edit({ action: "put_back", document: "cover_letter" })).toMatchObject({ isError: true, text: "Only the resume has parts left out." });
    await edit({ action: "leave_out", part_id: "summary" });
    expect(await edit({ action: "put_back", index: 3 })).toMatchObject({ isError: true, text: "Give the index of what to put back, from 0 to 0, as get_document's left_out lists them." });
    expect(await edit({ action: "restore_version" })).toMatchObject({ isError: true, text: "Give the version_id of the version to bring back, from get_document." });

    const job = (data: { type: string; status: "FAILED" | "DONE"; input?: Record<string, string>; result?: { outcome: string } }) =>
      prisma().job.create({ data: { ...data, applicationId: id, input: data.input ?? {} } });
    const failed = await job({ type: "regenerate-unit", status: "FAILED" });
    expect(await edit({ action: "undo", task_id: failed.id })).toMatchObject({ isError: true, text: "That rewrite didn't change anything, so there's nothing to undo." });
    const unchanged = await job({ type: "regenerate-unit", status: "DONE", input: { applicationId: id, document: "RESUME", unitId: "skills", from: "x" }, result: { outcome: "changed" } });
    expect(await edit({ action: "undo", task_id: unchanged.id })).toMatchObject({ isError: true, text: "That rewrite left the part as it was, so there's nothing to undo." });
    const other = await job({ type: "write-email", status: "DONE" });
    expect(await edit({ action: "undo", task_id: other.id })).toMatchObject({ isError: true, text: "That task isn't a rewrite of this application's documents. Give a task_id from rewrite_document." });
  });

  it("undoes the last change from the chat without a task", async () => {
    expect(await tool("edit_document", { application_id: id, document: "resume", action: "undo" })).toMatchObject({ isError: true, text: "There's no change from Dossier's chat to undo." });
    const summary = await summaryText();
    await prisma().document.update({
      where: { applicationId_kind: { applicationId: id, kind: "RESUME" } },
      data: { units: [{ id: "summary", label: "Summary", text: "Short." }, ...(await units()).slice(1)] },
    });
    await prisma().chatMessage.create({
      data: { applicationId: id, role: "AI", text: "Done.", writtenWith: "test", edits: [{ document: "RESUME", unitId: "summary", text: "Short.", previousText: summary }] },
    });
    expect((await tool("edit_document", { application_id: id, document: "resume", action: "undo" })).json).toMatchObject({ undone: "the last change from Dossier's chat" });
    expect(await summaryText()).toBe(summary);
  });

  it("changes the documents' theme, photo and layout", async () => {
    expect((await tool("set_document_look", { application_id: id, theme: "classic" })).json).toMatchObject({ theme: "Classic", theme_id: "classic", photo: "no photo in the profile" });
    const themes = await prisma().document.findMany({ where: { applicationId: id }, select: { themeId: true } });
    expect(themes.map((row) => row.themeId)).toEqual(["classic", "classic"]);
    expect((await tool("set_document_look", { application_id: id, theme: "Neon" })).text).toMatch(/^There's no theme called "Neon"\. The themes are Editorial, Classic, /);
    expect(await tool("set_document_look", { application_id: id, photo: true })).toMatchObject({ isError: true, text: "The profile has no photo. Add one on the Profile screen first." });
    expect(await tool("set_document_look", { application_id: id })).toMatchObject({ isError: true, text: "Say what to change: theme, photo, sidebar_layout or language." });

    const layout = await tool("set_document_look", { application_id: id, sidebar_layout: true });
    expect(layout.json.note).toBe("The Classic theme has no sidebar, so the layout switch shows once the documents have a theme with one.");
    expect(await prisma().application.findUniqueOrThrow({ where: { id } })).toMatchObject({ followThemeLayout: true });

    await prisma().profileField.create({ data: { key: "photo", value: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ" } });
    expect((await tool("set_document_look", { application_id: id, theme: "Modern", photo: false })).json).toMatchObject({ theme: "Modern", photo: false, sidebar_layout: true });
    expect(await prisma().application.findUniqueOrThrow({ where: { id } })).toMatchObject({ showPhoto: false });
    expect(await tool("set_document_look", { application_id: "gone", photo: false })).toMatchObject({ isError: true, text: "That application no longer exists." });
  });

  it("adds a skill the match is missing to the profile", async () => {
    const requirement = (text: string, skill: string | null) => ({ text, kind: skill ? "skill" : "other", skill, years: null, language: null });
    const gap = (text: string) => ({ requirement: text, result: "gap", skill: null, experienceIds: [], note: "Not in your profile" });
    await prisma().application.update({
      where: { id },
      data: {
        extracted: {
          title: null, company: "Ledgerly", role: null, location: null, mode: null, salary: null, deadline: null,
          requirements: [
            requirement("Experience with Kubernetes", "Kubernetes"),
            requirement("Fintech experience", null),
            requirement("Infrastructure as code with Terraform", "Terraform"),
          ],
          asksForReferences: false, language: "English",
        },
        match: { items: [gap("Experience with Kubernetes"), gap("Fintech experience"), gap("Infrastructure as code with Terraform")] },
      },
    });

    expect((await tool("add_match_skill", { application_id: id, skill: "kubernetes" })).json).toMatchObject({
      added: "Kubernetes",
      requirement: "Experience with Kubernetes",
      now: "partly covered",
      link: `https://dossier.example/applications/${id}?tab=posting`,
    });
    expect(await prisma().skill.findFirst({ where: { name: "Kubernetes" } })).not.toBeNull();
    const { match } = await prisma().application.findUniqueOrThrow({ where: { id } });
    expect(match).toMatchObject({ items: [{ result: "partial", skill: "Kubernetes" }, { result: "gap" }, { result: "gap" }] });

    expect(await tool("add_match_skill", { application_id: id, skill: "Kubernetes" })).toMatchObject({
      isError: true,
      text: "That isn't a skill this application's match is missing. These are: Terraform.",
    });
    expect(await tool("add_match_skill", { application_id: "gone", skill: "Terraform" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    // By its requirement's text too.
    expect((await tool("add_match_skill", { application_id: id, skill: "infrastructure as code with Terraform" })).json).toMatchObject({
      added: "Terraform",
      requirement: "Infrastructure as code with Terraform",
    });
    expect(await tool("add_match_skill", { application_id: id, skill: "Terraform" })).toMatchObject({ isError: true, text: "This application's match has no missing skill to add." });
  });

  it("makes the PDF the download button makes, with its file name", async () => {
    const resume = await tool("export_pdf", { application_id: id, document: "resume" });
    expect(renderPdf).toHaveBeenLastCalledWith(`/print/resume/${id}`);
    const download = `https://dossier.example/api/pdf?doc=resume&application=${id}`;
    expect(resume.json).toEqual({ file_name: "Jane Doe – Ledgerly – Resume.pdf", document: "resume", pages: 2, download, link: `https://dossier.example/applications/${id}` });
    expect(resume.content[1]).toEqual({ type: "resource", resource: { uri: download, mimeType: "application/pdf", blob: Buffer.from(PDF).toString("base64") } });

    expect((await tool("export_pdf", { application_id: id, document: "cover_letter" })).json).toMatchObject({ file_name: "Jane Doe – Ledgerly – Cover letter.pdf" });
    expect(renderPdf).toHaveBeenLastCalledWith(`/print/letter/${id}`);

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(renderPdf).mockRejectedValueOnce(new Error("Chromium crashed"));
    expect(await tool("export_pdf", { application_id: id, document: "resume" })).toMatchObject({
      isError: true,
      text: "The PDF couldn't be made just now. Try again in a moment, or use Download PDF on the application's page.",
    });
    await prisma().document.deleteMany({ where: { applicationId: id, kind: "COVER_LETTER" } });
    expect(await tool("export_pdf", { application_id: id, document: "cover_letter" })).toMatchObject({ isError: true, text: "This application has no cover letter." });
    expect(await tool("export_pdf", { application_id: "gone", document: "resume" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect(await tool("export_pdf", { application_id: id, document: "email" })).toMatchObject({ isError: true });
  });

  it("makes the base resume's PDF, which needs no application", async () => {
    const base = await tool("export_pdf", { document: "base_resume" });
    expect(renderPdf).toHaveBeenLastCalledWith("/print/base");
    const download = "https://dossier.example/api/pdf?doc=base";
    expect(base.json).toEqual({ file_name: "Jane Doe – Resume.pdf", document: "base_resume", pages: 2, download, link: "https://dossier.example/resume" });
    expect(base.content[1]).toEqual({ type: "resource", resource: { uri: download, mimeType: "application/pdf", blob: Buffer.from(PDF).toString("base64") } });

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(renderPdf).mockRejectedValueOnce(new Error("Chromium crashed"));
    expect(await tool("export_pdf", { document: "base_resume" })).toMatchObject({
      isError: true,
      text: "The PDF couldn't be made just now. Try again in a moment, or use Download PDF on the Base resume screen.",
    });

    // A tailored resume or cover letter names its application.
    vi.mocked(renderPdf).mockClear();
    const unnamed = { isError: true, text: "Give the application_id of the application whose resume or cover letter to make." };
    expect(await tool("export_pdf", { document: "resume" })).toMatchObject(unnamed);
    expect(await tool("export_pdf", { document: "cover_letter" })).toMatchObject(unnamed);
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it("checks a tailored resume's PDF as a parser reads it, answering with verdicts, labels and counts only", async () => {
    const content = resumeContent(demoProfile(), { units: demoResumeUnits() });
    vi.mocked(renderPdf).mockResolvedValueOnce(pdfWith(resumeLines(content)));
    const checked = await tool("check_resume", { application_id: id });
    expect(renderPdf).toHaveBeenLastCalledWith(`/print/resume/${id}`);
    const { reads, requirements, text, ...rest } = report(checked);
    expect(rest).toEqual({
      document: "resume",
      file_name: "Jane Doe – Ledgerly – Resume.pdf",
      pages: 1,
      max_pages: 2,
      checked_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      link: `https://dossier.example/applications/${id}`,
    });
    expect(reads.map((item) => [item.id, item.level])).toEqual([
      ["text-layer", "ok"],
      ["contact", "ok"],
      ["columns", "ok"],
      ["headings", "ok"],
      ["pages", "ok"],
      ["file-name", "ok"],
    ]);
    expect(reads[0].detail).toMatch(/^Every heading, title and bullet is in the PDF's text layer \(\d+ checked\)\.$/);
    expect(reads[3].detail).toBe("Profile, Experience, Projects, Education, Publications, Skills, Languages");
    // The posting's requirements, the job title first; years of experience aren't a word to find.
    expect(requirements).toMatchObject({ named: 4, total: 6 });
    expect(requirements!.items.map((item) => [item.index, item.named, item.in_profile, item.skill])).toEqual([
      [-1, true, true, null],
      [1, true, true, "Design systems"],
      [2, true, true, "User research"],
      [3, true, true, "Figma"],
      [4, false, false, null],
      [5, false, false, null],
      // A language: in the profile, but not one for the skills part.
      [6, true, true, null],
    ]);
    expect(requirements!.items[0].requirement).toBe("Senior Product Designer");
    expect(requirements!.items[4].requirement).toBe("Accessibility know-how (WCAG 2.2)");
    expect(text.map((item) => [item.id, item.level, item.title])).toEqual([
      ["characters", "ok", "Plain characters"],
      ["language", "ok", "Written in English"],
      ["dates", "ok", "Dates in one style"],
    ]);
    // Nothing the resume says, and no contact detail.
    for (const secret of ["jane.doe@example.com", "+31 6 1234 5678", "1234 5678", "Westersingel", "linkedin.com/in", content.summary.slice(0, 40), content.experience[0].bullets[0]]) {
      expect(checked.text).not.toContain(secret);
    }
  });

  it("checks the base resume without an application, and says why a check can't run", async () => {
    await saveSettings({ includeRefs: true });
    vi.mocked(renderPdf).mockResolvedValueOnce(pdfWith(resumeLines(resumeContent(demoProfile(), { includeReferences: true }))));
    const base = await tool("check_resume", { document: "base_resume" });
    expect(renderPdf).toHaveBeenLastCalledWith("/print/base");
    const { reads, requirements, text, ...rest } = report(base);
    expect(rest).toMatchObject({ document: "base_resume", file_name: "Jane Doe – Resume.pdf", pages: 1, max_pages: 2, link: "https://dossier.example/resume" });
    expect(requirements).toBeNull();
    expect(reads.map((item) => [item.id, item.level])).toEqual([
      ["text-layer", "ok"],
      ["contact", "ok"],
      ["columns", "ok"],
      ["headings", "ok"],
      ["pages", "ok"],
      ["file-name", "ok"],
    ]);
    expect(reads[3].detail).toBe("Profile, Experience, Projects, Education, Publications, References, Skills, Languages");
    expect(text.map((item) => item.id)).toEqual(["characters", "dates"]);
    // A reference's email stays out as the user's own does.
    for (const secret of ["jane.doe@example.com", "john.doe@example.com", "+31 6 1234 5678"]) expect(base.text).not.toContain(secret);

    // A tailored resume names its application; one that's gone is a refusal, not an error to log.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    errors.mockClear();
    vi.mocked(renderPdf).mockClear();
    expect(await tool("check_resume", { document: "resume" })).toMatchObject({ isError: true, text: "Give the application_id of the application whose resume to check." });
    expect(await tool("check_resume", { application_id: "gone" })).toMatchObject({ isError: true, text: "That application no longer exists." });
    expect(renderPdf).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();

    vi.mocked(renderPdf).mockRejectedValueOnce(new Error("Chromium crashed"));
    expect(await tool("check_resume", { application_id: id })).toMatchObject({
      isError: true,
      text: "The resume couldn't be checked just now. Try again in a moment, or check it in Dossier on the application's Resume tab.",
    });
    expect(errors).toHaveBeenCalledTimes(1);
    await prisma().document.deleteMany({ where: { applicationId: id, kind: "RESUME" } });
    expect(await tool("check_resume", { application_id: id })).toMatchObject({ isError: true, text: "This application has no tailored resume." });
  });

  it("changes the language the documents are written in, which their headings, dates and the check follow", async () => {
    const changed = await tool("set_document_look", { application_id: id, language: "german" });
    expect(changed.json).toMatchObject({ theme: "Editorial", language: "German", link: `https://dossier.example/applications/${id}` });
    expect((await prisma().application.findUniqueOrThrow({ where: { id } })).language).toBe("German");

    // The resume's English text under German headings: the check says so, with the language to set.
    const labels = documentLabels("German");
    vi.mocked(renderPdf).mockResolvedValueOnce(pdfWith(resumeLines(resumeContent(demoProfile(), { units: demoResumeUnits() }, labels), labels)));
    const { reads, text } = report(await tool("check_resume", { application_id: id }));
    expect(reads.find((item) => item.id === "headings")).toMatchObject({
      level: "ok",
      detail: [labels.profile, labels.experience, labels.projects, labels.education, labels.publications, labels.skills, labels.languages].join(", "),
    });
    expect(text.find((item) => item.id === "language")).toEqual({
      id: "language",
      level: "warn",
      title: "Text in English under German headings and dates",
      detail: "The application is set to German, which the headings and dates follow, but the text reads as English.",
      fix: { kind: "language", language: "English" },
    });

    // A language added with “Other language…” counts; one Dossier doesn't know is refused, and nothing changes then.
    await saveSettings({ customLanguages: ["Klingon"] });
    expect((await tool("set_document_look", { application_id: id, language: "klingon" })).json).toMatchObject({ language: "Klingon" });
    const unknown = await tool("set_document_look", { application_id: id, language: "Elvish" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/^Dossier doesn't know the language "Elvish"\. The languages are English, Dutch, German, /);
    expect((await prisma().application.findUniqueOrThrow({ where: { id } })).language).toBe("Klingon");
  });
});
