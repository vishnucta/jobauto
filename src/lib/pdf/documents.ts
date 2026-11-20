import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { AttachmentError, enabledAttachments, mergePdfs } from "@/lib/attachments";
import { resolveFileName } from "@/lib/file-name";
import { prisma } from "@/lib/prisma";
import { workSampleOf } from "@/lib/work-sample";
import { loadProfileName } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { FIT_LEVELS } from "@/lib/themes";

import { countPdfPages, printBasePath } from "./pages";
import { renderPdf } from "./render";

/** The letter, the resume and the Anlagen, in the order a German application is read. */
async function renderMappe(applicationId: string, name: string, pattern: string, date: Date): Promise<{ pdf: Uint8Array; fileName: string } | { error: string }> {
  const application = APPLICATION_ID.test(applicationId)
    ? await prisma.application.findUnique({ where: { id: applicationId }, select: { company: true, role: true, workSample: true, documents: { select: { kind: true } } } })
    : null;
  if (!application) return { error: "That application no longer exists." };
  const has = (kind: DocumentKind) => application.documents.some((document) => document.kind === kind);
  const sample = workSampleOf(application.workSample);
  if (!has(DocumentKind.RESUME) && !has(DocumentKind.COVER_LETTER)) return { error: "This application has no resume or cover letter yet." };
  let anlagen: Awaited<ReturnType<typeof enabledAttachments>>;
  try {
    anlagen = await enabledAttachments();
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message };
    throw error;
  }
  const parts = [
    has(DocumentKind.COVER_LETTER) ? await renderPdf(`/print/letter/${applicationId}`) : null,
    has(DocumentKind.RESUME) ? await renderPdf(`/print/resume/${applicationId}`) : null,
    sample?.inMappe ? await renderPdf(`/print/sample/${applicationId}`) : null,
    ...anlagen.map((file) => file.data),
  ].filter((part): part is Uint8Array => part !== null);
  return {
    pdf: await mergePdfs(parts),
    fileName: resolveFileName(pattern, { name, company: application.company, role: application.role, doc: DocumentKind.RESUME, label: "Bewerbungsmappe", date }),
  };
}

// The documents Dossier makes PDFs of (RES-5, APP-12): the base resume, and
// an application's tailored resume and cover letter, printed from their
// print pages and named with Settings → PDF file name (SET-8). The Download
// PDF buttons (src/app/api/pdf) and the Claude connector's export_pdf
// (src/lib/connector/tools/documents.ts) both render them here.

/**
 * A document with a PDF, as `?doc=` names it: the base resume, an
 * application's tailored resume or cover letter, or its Bewerbungsmappe:
 * the letter, the resume and the Anlagen in one PDF (jobauto fork), for the
 * many German job portals that take a single file.
 */
export type PdfDocument = "base" | "resume" | "letter" | "mappe" | "kurzprofil" | "sample";

/** The tailored documents, by their `doc=` value. */
const TAILORED = { resume: DocumentKind.RESUME, letter: DocumentKind.COVER_LETTER } as const;

/** Application ids are cuids; anything else never reaches a print path. */
const APPLICATION_ID = /^[a-z0-9]{1,64}$/i;

/** A document's PDF with its file name, or why there's none to make. A tailored one names its application. */
export async function renderDocumentPdf(doc: PdfDocument, applicationId = ""): Promise<{ pdf: Uint8Array; fileName: string } | { error: string }> {
  const [name, settings] = await Promise.all([loadProfileName(), loadSettings()]);
  const date = new Date();

  if (doc === "base") {
    // "Fit to one page" (public issue 69): squeezed a step at a time until it fits, as the preview does.
    let pdf = await renderPdf(printBasePath());
    for (let fit = 1; settings.fitBaseResume && fit <= FIT_LEVELS && countPdfPages(pdf) > 1; fit++) pdf = await renderPdf(printBasePath(fit));
    return { pdf, fileName: resolveFileName(settings.fileNamePattern, { name, doc: DocumentKind.RESUME, date }) };
  }

  if (doc === "mappe") return renderMappe(applicationId, name, settings.fileNamePattern, date);
  if (doc === "sample") {
    const application = APPLICATION_ID.test(applicationId) ? await prisma.application.findUnique({ where: { id: applicationId }, select: { company: true, role: true, workSample: true } }) : null;
    if (!application) return { error: "That application no longer exists." };
    if (!workSampleOf(application.workSample)) return { error: "This application has no work sample yet." };
    return {
      pdf: await renderPdf(`/print/sample/${applicationId}`),
      fileName: resolveFileName(settings.fileNamePattern, { name, company: application.company, role: application.role, doc: DocumentKind.RESUME, label: "Arbeitsprobe", date }),
    };
  }
  // The Kurzprofil for agencies (jobauto fork): from the profile, like the base resume.
  if (doc === "kurzprofil") return { pdf: await renderPdf("/print/kurzprofil"), fileName: resolveFileName(settings.fileNamePattern, { name, doc: DocumentKind.RESUME, label: "Kurzprofil", date }) };

  const application = APPLICATION_ID.test(applicationId)
    ? await prisma.application.findUnique({
        where: { id: applicationId },
        select: { company: true, role: true, documents: { where: { kind: TAILORED[doc] }, select: { id: true } } },
      })
    : null;
  if (!application) return { error: "That application no longer exists." };
  if (application.documents.length === 0) {
    return { error: doc === "resume" ? "This application has no tailored resume." : "This application has no cover letter." };
  }

  return {
    pdf: await renderPdf(`/print/${doc}/${applicationId}`),
    fileName: resolveFileName(settings.fileNamePattern, { name, company: application.company, role: application.role, doc: TAILORED[doc], date }),
  };
}
