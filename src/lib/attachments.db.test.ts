import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { addAttachment, deleteAllAttachments, enabledAttachments, listAttachments, mergePdfs, nameFromFile, readAttachment, removeAttachment, updateAttachment } from "./attachments";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined, dir: "" }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({
  get env() {
    return { DOSSIER_DATA_DIR: db.dir };
  },
}));
const prisma = () => db.client!;

/** A PDF of `pages` blank pages. */
async function pdf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage([595, 842]);
  return document.save();
}

beforeEach(async () => {
  await resetDatabase(prisma());
  db.dir = mkdtempSync(path.join(tmpdir(), "anlagen-"));
});
afterAll(async () => {
  await rm(db.dir, { recursive: true, force: true });
  await prisma().$disconnect();
});

describe("Anlagen", () => {
  it("keeps a PDF with a name from its file, and gives it back", async () => {
    const bytes = await pdf(2);
    const added = await addAttachment(bytes, "Arbeitszeugnis_AvaTrade.pdf");
    expect(added).toMatchObject({ name: "Arbeitszeugnis AvaTrade", fileName: "Arbeitszeugnis_AvaTrade.pdf", size: bytes.byteLength, enabled: true });
    expect((await readAttachment(added.id))?.data.byteLength).toBe(bytes.byteLength);
    expect(await listAttachments()).toHaveLength(1);
  });

  it("refuses what isn't a PDF that opens", async () => {
    await expect(addAttachment(new TextEncoder().encode("hello"), "notes.txt")).rejects.toThrow("Only PDFs can be added.");
    await expect(addAttachment(new TextEncoder().encode("%PDF-1.7 broken"), "broken.pdf")).rejects.toThrow("That PDF can't be opened");
    await expect(addAttachment(new Uint8Array(), "empty.pdf")).rejects.toThrow("That file is empty.");
    expect(await listAttachments()).toEqual([]);
  });

  it("sends only the ones that are on, in order, and forgets one when removed", async () => {
    const first = await addAttachment(await pdf(1), "Zeugnis.pdf");
    const second = await addAttachment(await pdf(1), "Goethe-Zertifikat A2.pdf");
    await updateAttachment(first.id, { enabled: false, name: "Arbeitszeugnis EY" });
    expect((await enabledAttachments()).map((file) => file.name)).toEqual(["Goethe Zertifikat A2"]);
    expect(await removeAttachment(second.id)).toBe(true);
    expect(await readAttachment(second.id)).toBeNull();
    await deleteAllAttachments();
    expect(await listAttachments()).toEqual([]);
  });

  it("puts PDFs one after another into one", async () => {
    const merged = await PDFDocument.load(await mergePdfs([await pdf(1), await pdf(2), await pdf(3)]));
    expect(merged.getPageCount()).toBe(6);
  });

  it("names a file without its extension or underscores", () => {
    expect(nameFromFile("Bachelor_of_Commerce--Zeugnis.PDF")).toBe("Bachelor of Commerce Zeugnis");
    expect(nameFromFile(".pdf")).toBe("Anlage");
  });
});
