import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { MockProvider } from "../ai/providers/mock";

import { englishCopyJob } from "./english-copy";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
const ai = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/ai/task-options", () => ({ loadTaskOptions: async () => ({ creativity: "BALANCED", strict: true, language: null }) }));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getAiProvider: async () =>
    new MockProvider({
      reply: (call) => {
        ai.asked.push(call.messages[0].content);
        return { parts: [{ unitId: "paragraph:1", text: "I read your posting with great interest." }] };
      },
    }),
}));
const prisma = () => db.client!;

beforeEach(async () => {
  await resetDatabase(prisma());
  ai.asked = [];
});
afterAll(() => prisma().$disconnect());

describe("englishCopyJob", () => {
  it("writes the letter's parts in English, without the sender or signature, and saves nothing", async () => {
    const units = [
      { id: "sender", label: "Sender", text: "Erika Mustermann\nPinneberg · erika@example.com" },
      { id: "paragraph:1", label: "Opening", text: "Mit großem Interesse habe ich Ihre Anzeige gelesen." },
      { id: "signature", label: "Signature", text: "Erika Mustermann" },
    ];
    const application = await prisma().application.create({ data: { company: "Nordbank", language: "German", documents: { create: { kind: "COVER_LETTER", units } } } });
    const result = await englishCopyJob.run({ applicationId: application.id, kind: "COVER_LETTER" }, { id: "job", step: async () => {}, signal: new AbortController().signal });
    expect(result).toEqual({ parts: [{ label: "Opening", text: "I read your posting with great interest." }] });
    expect(ai.asked.join("\n")).not.toContain("erika@example.com");
    const stored = await prisma().document.findFirstOrThrow({ where: { applicationId: application.id } });
    expect(stored.units).toEqual(units);
  });
});
