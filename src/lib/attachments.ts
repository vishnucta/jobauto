import "server-only";

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

import type { AttachmentView } from "./attachment-types";

// Anlagen (jobauto fork): certificates and reference letters kept once, as
// PDFs in DOSSIER_DATA_DIR/attachments, and sent with applications.

/** Per file: a scan of a few pages fits, and Gmail's 25 MB allows a few of them with the documents. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
/** All enabled together, for an email's 25 MB with the resume and letter. */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export class AttachmentError extends Error {}

const attachmentsDir = () => path.join(env.DOSSIER_DATA_DIR, "attachments");
/** Ids are cuids, so a path can't leave the folder. */
const filePath = (id: string) => path.join(attachmentsDir(), `${id.replace(/[^a-z0-9]/gi, "")}.pdf`);

const view = (row: { id: string; name: string; fileName: string; size: number; enabled: boolean }): AttachmentView => ({
  id: row.id,
  name: row.name,
  fileName: row.fileName,
  size: row.size,
  enabled: row.enabled,
});

export async function listAttachments(): Promise<AttachmentView[]> {
  return (await prisma.attachment.findMany({ orderBy: [{ sort: "asc" }, { createdAt: "asc" }] })).map(view);
}

/** "Arbeitszeugnis AvaTrade" from "Arbeitszeugnis_AvaTrade.pdf". */
export const nameFromFile = (fileName: string) =>
  fileName
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "Anlage";

/** Keeps an uploaded PDF. Only a PDF that opens is kept: a portal that gets a broken file drops the application. */
export async function addAttachment(bytes: Uint8Array, fileName: string): Promise<AttachmentView> {
  if (bytes.byteLength === 0) throw new AttachmentError("That file is empty.");
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new AttachmentError("That file is over 8 MB. Make it smaller, for example by scanning in black and white, and add it again.");
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new AttachmentError("Only PDFs can be added. Save or scan it as a PDF first.");
  // pdf-lib reads damaged files leniently: one without a page didn't open.
  let pages = 0;
  try {
    pages = (await PDFDocument.load(bytes, { ignoreEncryption: false })).getPageCount();
  } catch {
    pages = 0;
  }
  if (pages === 0) throw new AttachmentError("That PDF can't be opened, or it's locked with a password. Save it again without one, and add it again.");
  const count = await prisma.attachment.count();
  if (count >= MAX_ATTACHMENTS) throw new AttachmentError(`That's ${MAX_ATTACHMENTS} already. Remove one first.`);
  const cleanName = path.basename(fileName).slice(0, 200) || "Anlage.pdf";
  const row = await prisma.attachment.create({ data: { name: nameFromFile(cleanName), fileName: cleanName, size: bytes.byteLength, sort: count } });
  await mkdir(attachmentsDir(), { recursive: true });
  await writeFile(filePath(row.id), bytes);
  return view(row);
}

/** Renames it, or turns sending it on or off; null when it's gone. */
export async function updateAttachment(id: string, change: { name?: string; enabled?: boolean }): Promise<AttachmentView | null> {
  const { count } = await prisma.attachment.updateMany({ where: { id }, data: change });
  return count ? view(await prisma.attachment.findUniqueOrThrow({ where: { id } })) : null;
}

export async function removeAttachment(id: string): Promise<boolean> {
  const { count } = await prisma.attachment.deleteMany({ where: { id } });
  await rm(filePath(id), { force: true });
  return count > 0;
}

/** Every file, for Delete everything. */
export async function deleteAllAttachments(): Promise<void> {
  await prisma.attachment.deleteMany();
  await rm(attachmentsDir(), { recursive: true, force: true });
}

export async function readAttachment(id: string): Promise<{ data: Uint8Array; fileName: string } | null> {
  const row = await prisma.attachment.findUnique({ where: { id } });
  if (!row) return null;
  try {
    return { data: await readFile(filePath(row.id)), fileName: row.fileName };
  } catch {
    return null;
  }
}

/** The ones sent with applications, in order, with their files; one whose file is missing is left out. */
export async function enabledAttachments(): Promise<{ name: string; fileName: string; data: Uint8Array }[]> {
  const rows = await prisma.attachment.findMany({ where: { enabled: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
  const files: { name: string; fileName: string; data: Uint8Array }[] = [];
  for (const row of rows) {
    const file = await readAttachment(row.id);
    if (file) files.push({ name: row.name, fileName: row.fileName, data: file.data });
  }
  if (files.reduce((sum, file) => sum + file.data.byteLength, 0) > MAX_TOTAL_BYTES) {
    throw new AttachmentError("Your Anlagen together are over 20 MB, more than an email can carry with your documents. Turn some off in Settings → Documents.");
  }
  return files;
}

/** PDFs one after another, as one PDF: the Bewerbungsmappe. */
export async function mergePdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const part of parts) {
    const source = await PDFDocument.load(part);
    for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
  }
  return merged.save();
}
