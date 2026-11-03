import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { ActionError } from "./action";
import { setDocumentLook } from "./document-look";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});

const prisma = () => db.client!;
const application = () => prisma().application.findUniqueOrThrow({ where: { id: "app-1" } });

beforeEach(async () => {
  await resetDatabase(prisma());
  await prisma().application.create({
    data: {
      id: "app-1",
      language: "English",
      documents: { create: [{ kind: "RESUME", units: [{ id: "summary", label: "Summary", text: "One" }] }] },
    },
  });
});
afterAll(() => prisma().$disconnect());

describe("setDocumentLook", () => {
  it("records the language the documents are written in, as the list spells it", async () => {
    await setDocumentLook("app-1", { language: "german" });
    expect(await application()).toMatchObject({ language: "German", followThemeLayout: false, showPhoto: null });
    await setDocumentLook("app-1", { language: " Chinese (simplified) " });
    expect((await application()).language).toBe("Chinese (Simplified)");
  });

  it("knows the languages added with “Other language…” too", async () => {
    await saveSettings({ customLanguages: ["Klingon"] });
    await setDocumentLook("app-1", { language: "klingon" });
    expect((await application()).language).toBe("Klingon");
  });

  it("refuses a language it doesn't know, or none at all, and changes nothing then", async () => {
    await expect(setDocumentLook("app-1", { language: "Elvish" })).rejects.toThrow(ActionError);
    await expect(setDocumentLook("app-1", { language: "Elvish" })).rejects.toThrow(/^Dossier doesn't know the language "Elvish"\. The languages are English, Dutch, German, /);
    await expect(setDocumentLook("app-1", { language: " " })).rejects.toThrow("Say which language the documents are written in.");
    expect((await application()).language).toBe("English");
  });

  it("checks the language before anything is written, so a refused one leaves the theme as it was", async () => {
    await prisma().theme.create({ data: { id: "classic", name: "Classic", headFont: "GARAMOND", bodyFont: "GARAMOND", accent: "#1d1c1a" } });
    await expect(setDocumentLook("app-1", { themeId: "classic", language: "Elvish" })).rejects.toThrow(/^Dossier doesn't know the language "Elvish"/);
    expect(await prisma().document.findFirstOrThrow({ where: { applicationId: "app-1" } })).toMatchObject({ themeId: null });
    await setDocumentLook("app-1", { themeId: "classic", language: "German" });
    expect(await prisma().document.findFirstOrThrow({ where: { applicationId: "app-1" } })).toMatchObject({ themeId: "classic" });
    expect((await application()).language).toBe("German");
  });

  it("changes the photo and the layout together, and only them", async () => {
    await setDocumentLook("app-1", { showPhoto: false, followThemeLayout: true });
    expect(await application()).toMatchObject({ language: "English", followThemeLayout: true, showPhoto: false });
    await setDocumentLook("app-1", { language: "Dutch" });
    expect(await application()).toMatchObject({ language: "Dutch", followThemeLayout: true, showPhoto: false });
  });

  it("says when the application is gone", async () => {
    await expect(setDocumentLook("gone", { language: "German" })).rejects.toThrow("That application no longer exists.");
    await expect(setDocumentLook("gone", { showPhoto: true })).rejects.toThrow("That application no longer exists.");
  });
});
