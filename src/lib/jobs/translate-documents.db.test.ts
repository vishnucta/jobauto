import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MockProvider } from "@/lib/ai/providers/mock";
import { demoProfile } from "@/lib/demo-profile";
import { documentLabels, languagesLine } from "@/lib/document-labels";
import { createTestClient, resetDatabase } from "@/test/db";

import { translateDocumentsJob } from "./translate-documents";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const provider = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/ai", () => ({ getAiProvider: async () => provider.current }));
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: async () => ({ creativity: "BALANCED", strict: true, language: null }) }));
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile(), loadFactTexts: async () => [] };
});
vi.mock("./runner", () => ({ defineJob: <T,>(definition: T) => definition }));

const prisma = () => db.client!;
const steps: string[] = [];
const context = { id: "test-job", step: async (name: string) => void steps.push(name), signal: new AbortController().signal };

type Parts = { unitId: string; part: string; text: string }[];

/** What the model was asked for: the parts in the message's JSON. */
const asked = (content: string): Parts => JSON.parse(content.slice(content.indexOf("\n") + 1));

/** A model that writes each part as "[de] …", except those named in `skip`. */
function german(skip: string[] = [], before?: (call: { document: string }) => Promise<void>) {
  return new MockProvider({
    reply: async (call) => {
      const content = call.messages[0].content as string;
      const document = /parts of the (resume|cover letter|application email) in/.exec(content)?.[1] ?? "";
      await before?.({ document });
      return { parts: asked(content).filter((part) => !skip.includes(part.unitId)).map((part) => ({ unitId: part.unitId, text: `[de] ${part.text}` })) };
    },
  });
}

const resume = [
  { id: "summary", label: "Summary", text: "Calm tools for complex work.", unverified: ["40%"] },
  { id: "experience:e1", label: "Northwind role", text: "Led the portal\nBuilt the design system" },
  { id: "publication:p1", label: "A paper", text: "Doe, J. (2024). Calm interfaces. Journal of Tools." },
  { id: "languages", label: "Languages", text: "Dutch: Native · English: Fluent (C2)" },
];
const letter = [
  { id: "sender", label: "Sender", text: "Jane Doe\njane.doe@example.com · +31 6 1234 5678" },
  { id: "date", label: "Date", text: "3 November 2026" },
  { id: "recipient", label: "Recipient", text: "Ledgerly · Hiring team\nAmsterdam" },
  { id: "greeting", label: "Greeting", text: "Dear Ledgerly team," },
  { id: "paragraph:1", label: "Opening", text: "I'm applying for the Senior Product Designer role." },
  { id: "sign-off", label: "Sign-off", text: "Warm regards," },
  { id: "signature", label: "Signature", text: "Jane Doe" },
];
const email = [
  { id: "to", label: "Recipient", text: "Hiring Team <jobs@ledgerly.example>" },
  { id: "subject", label: "Subject", text: "Senior Product Designer: Jane Doe" },
  { id: "body", label: "Message", text: "Dear team,\n\nPlease find my application attached.\n\nWarm regards,\nJane" },
];
const where = (kind: "RESUME" | "COVER_LETTER" | "EMAIL") => ({ applicationId_kind: { applicationId: "app-1", kind } });
const unitsOf = async (kind: "RESUME" | "COVER_LETTER" | "EMAIL") =>
  Object.fromEntries(((await prisma().document.findUniqueOrThrow({ where: where(kind) })).units as { id: string; text: string }[]).map((unit) => [unit.id, unit.text]));

async function makeApplication(data: Record<string, unknown> = {}, withEmail = true) {
  await prisma().application.create({
    data: {
      id: "app-1",
      company: "Ledgerly",
      role: "Senior Product Designer",
      language: "English",
      tone: "WARM",
      postingText: "Ledgerly is hiring a Senior Product Designer.",
      documents: {
        // Each starts its history with the first draft, as an application does.
        create: [
          { kind: "RESUME", units: resume, versions: { create: { units: resume, cause: "WRITTEN" } } },
          { kind: "COVER_LETTER", units: letter, versions: { create: { units: letter, cause: "WRITTEN" } } },
          ...(withEmail ? [{ kind: "EMAIL" as const, units: email, versions: { create: { units: email, cause: "WRITTEN" as const } } }] : []),
        ],
      },
      ...data,
    },
  });
}

beforeEach(async () => {
  steps.length = 0;
  await resetDatabase(prisma());
  provider.current = german();
});
afterAll(() => prisma().$disconnect());

describe("translateDocumentsJob", () => {
  it("writes the resume, the cover letter and the email in the language, and sets the application's language", async () => {
    await makeApplication();
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(steps).toEqual(["Rewriting the resume", "Rewriting the cover letter", "Rewriting the email", "Saving"]);
    // The resume's summary and role, the letter's date, recipient, greeting, paragraph and sign-off, the email's subject and message.
    expect(result).toEqual({ language: "German", rewritten: 9, left: [] });

    expect(await unitsOf("RESUME")).toMatchObject({ summary: "[de] Calm tools for complex work.", "experience:e1": "[de] Led the portal\nBuilt the design system" });
    expect(await unitsOf("COVER_LETTER")).toMatchObject({
      date: "[de] 3 November 2026",
      recipient: "[de] Ledgerly · Hiring team\nAmsterdam",
      greeting: "[de] Dear Ledgerly team,",
      "paragraph:1": "[de] I'm applying for the Senior Product Designer role.",
      "sign-off": "[de] Warm regards,",
    });
    expect(await unitsOf("EMAIL")).toMatchObject({ subject: "[de] Senior Product Designer: Jane Doe", body: expect.stringMatching(/^\[de\] Dear team,/) });
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "app-1" } })).toMatchObject({ language: "German" });
  });

  it("keeps what the model never sees: publications, the sender and signature, the email's recipient", async () => {
    await makeApplication();
    await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    const resumeAfter = await unitsOf("RESUME");
    expect(resumeAfter["publication:p1"]).toBe(resume[2].text);
    const letterAfter = await unitsOf("COVER_LETTER");
    expect(letterAfter.sender).toBe(letter[0].text);
    expect(letterAfter.signature).toBe("Jane Doe");
    expect((await unitsOf("EMAIL")).to).toBe(email[0].text);

    const everything = (provider.current as MockProvider).calls.map((call) => JSON.stringify(call)).join("\n");
    for (const private_ of ["jane.doe@example.com", "+31 6 1234 5678", "jobs@ledgerly.example", "Calm interfaces"]) expect(everything).not.toContain(private_);
  });

  it("writes the resume's languages again from the profile, in the new language's words", async () => {
    await makeApplication();
    await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect((await unitsOf("RESUME")).languages).toBe(languagesLine(demoProfile().languages, documentLabels("German")));
  });

  it("keeps the flag on a part that has one, and saves each changed document as a version", async () => {
    await makeApplication();
    await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    const saved = (await prisma().document.findUniqueOrThrow({ where: where("RESUME") })).units as { id: string; unverified?: string[] }[];
    expect(saved.find((unit) => unit.id === "summary")?.unverified).toEqual(["40%"]);
    // Nothing was edited by hand, so nothing needs saving first: the first draft is the version before.
    const versions = await prisma().documentVersion.findMany({ where: { cause: "REFINED" }, select: { cause: true, detail: true } });
    expect(versions).toHaveLength(3);
    expect(versions.every((version) => version.cause === "REFINED" && version.detail === "Rewritten in German")).toBe(true);
  });

  it("works without an email", async () => {
    await makeApplication({}, false);
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(steps).toEqual(["Rewriting the resume", "Rewriting the cover letter", "Saving"]);
    expect(result.rewritten).toBe(7);
  });

  it("leaves a part the model skipped, and says which", async () => {
    await makeApplication();
    provider.current = german(["paragraph:1"]);
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(result).toEqual({ language: "German", rewritten: 8, left: ["opening paragraph"] });
    expect((await unitsOf("COVER_LETTER"))["paragraph:1"]).toBe(letter[4].text);
  });

  it("lets an edit made meanwhile win over the translation of that part", async () => {
    await makeApplication();
    provider.current = german([], async ({ document }) => {
      if (document !== "cover letter") return;
      await prisma().document.update({
        where: where("COVER_LETTER"),
        data: { units: letter.map((unit) => (unit.id === "greeting" ? { ...unit, text: "Hello Ledgerly team," } : unit)) },
      });
    });
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(result).toEqual({ language: "German", rewritten: 8, left: ["greeting"] });
    expect((await unitsOf("COVER_LETTER")).greeting).toBe("Hello Ledgerly team,");
  });

  it("gives an English letter the tone's own sign-off", async () => {
    await makeApplication({ language: "German", tone: "DIRECT" });
    await translateDocumentsJob.run({ applicationId: "app-1", language: "English" }, context);
    expect((await unitsOf("COVER_LETTER"))["sign-off"]).toBe("Best,");
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "app-1" } })).toMatchObject({ language: "English" });
  });

  it("changes nothing, not even the language, when no part came back", async () => {
    await makeApplication();
    provider.current = new MockProvider({ reply: () => ({ parts: [] }) });
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(result.rewritten).toBe(0);
    expect(result.left.length).toBeGreaterThan(0);
    expect(await prisma().application.findUniqueOrThrow({ where: { id: "app-1" } })).toMatchObject({ language: "English" });
    expect(await unitsOf("RESUME")).toMatchObject({ summary: "Calm tools for complex work.", languages: "Dutch: Native · English: Fluent (C2)" });
    expect(await prisma().documentVersion.count({ where: { cause: "REFINED" } })).toBe(0);
  });

  it("saves what was edited by hand first, so the rewrite can be undone", async () => {
    await makeApplication();
    await prisma().document.update({
      where: where("RESUME"),
      data: { units: resume.map((unit) => (unit.id === "summary" ? { ...unit, text: "My own words about calm tools." } : unit)) },
    });
    await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    const resumeId = (await prisma().document.findUniqueOrThrow({ where: where("RESUME") })).id;
    const versions = await prisma().documentVersion.findMany({ where: { documentId: resumeId }, orderBy: { createdAt: "asc" } });
    expect(versions.map((version) => [version.cause, version.detail])).toEqual([
      ["WRITTEN", ""],
      ["REFINED", "Before rewriting in German"],
      ["REFINED", "Rewritten in German"],
    ]);
    expect((versions[1].units as { id: string; text: string }[]).find((unit) => unit.id === "summary")?.text).toBe("My own words about calm tools.");
    expect((versions[2].units as { id: string; text: string }[]).find((unit) => unit.id === "summary")?.text).toBe("[de] My own words about calm tools.");
    // The letter and the email weren't edited: no extra version.
    const letterId = (await prisma().document.findUniqueOrThrow({ where: where("COVER_LETTER") })).id;
    expect(await prisma().documentVersion.count({ where: { documentId: letterId } })).toBe(2);
  });

  it("writes the parts left out of the resume too, so Put back doesn't bring the old language back", async () => {
    await makeApplication();
    const leftOut = [
      { kind: "unit", index: 3, unit: { id: "project:p9", label: "Side project", text: "Built a small plugin for the design tokens of the team" } },
      { kind: "bullets", unitId: "experience:e1", label: "Northwind role", lines: ["Mentored three junior designers", "Ran the monthly research sessions"] },
      { kind: "unit", index: 5, unit: { id: "publication:p2", label: "A paper", text: "Doe, J. (2023). Calm tools. Journal of Tools." } },
    ];
    await prisma().document.update({ where: where("RESUME"), data: { trimmed: leftOut } });
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(result).toEqual({ language: "German", rewritten: 9, left: [] });

    const { trimmed } = await prisma().document.findUniqueOrThrow({ where: where("RESUME") });
    const [part, bullets, citation] = trimmed as { unit?: { text: string }; lines?: string[] }[];
    expect(part.unit?.text).toBe("[de] Built a small plugin for the design tokens of the team");
    expect(bullets.lines).toEqual(["[de] Mentored three junior designers", "Ran the monthly research sessions"]);
    // A publication is the candidate's own citation: neither sent nor changed.
    expect(citation.unit?.text).toBe("Doe, J. (2023). Calm tools. Journal of Tools.");
    const sent = (provider.current as MockProvider).calls.map((call) => JSON.stringify(call)).join("\n");
    expect(sent).toContain("Mentored three junior designers");
    expect(sent).not.toContain("Calm tools. Journal of Tools");
  });

  it("keeps a left-out part that was changed meanwhile, and says which", async () => {
    await makeApplication();
    const original = { kind: "unit", index: 3, unit: { id: "project:p9", label: "Side project", text: "Built a small plugin for the design tokens of the team" } };
    await prisma().document.update({ where: where("RESUME"), data: { trimmed: [original] } });
    provider.current = german([], async ({ document }) => {
      if (document !== "resume") return;
      await prisma().document.update({ where: where("RESUME"), data: { trimmed: [{ ...original, unit: { ...original.unit, text: "Edited by hand." } }] } });
    });
    const result = await translateDocumentsJob.run({ applicationId: "app-1", language: "German" }, context);
    expect(result.left).toEqual(["Side project"]);
    expect(((await prisma().document.findUniqueOrThrow({ where: where("RESUME") })).trimmed as { unit: { text: string } }[])[0].unit.text).toBe("Edited by hand.");
  });

  it("leaves a hand-edited sign-off and languages line alone when the language isn't changing", async () => {
    await makeApplication();
    await prisma().document.update({
      where: where("COVER_LETTER"),
      data: { units: letter.map((unit) => (unit.id === "sign-off" ? { ...unit, text: "Kind regards, and thank you for your time," } : unit)) },
    });
    await prisma().document.update({
      where: where("RESUME"),
      data: { units: resume.map((unit) => (unit.id === "languages" ? { ...unit, text: "Dutch: Native · English: Fluent" } : unit)) },
    });
    // The application is set to English already; the text may not be.
    await translateDocumentsJob.run({ applicationId: "app-1", language: "English" }, context);
    expect((await unitsOf("COVER_LETTER"))["sign-off"]).toBe("[de] Kind regards, and thank you for your time,");
    expect((await unitsOf("RESUME")).languages).toBe("Dutch: Native · English: Fluent");
  });

  it("does nothing for an application that is gone", async () => {
    expect(await translateDocumentsJob.run({ applicationId: "gone", language: "German" }, context)).toEqual({ language: "German", rewritten: 0, left: [] });
    expect((provider.current as MockProvider).calls).toHaveLength(0);
  });
});
