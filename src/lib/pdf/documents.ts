import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { resolveFileName } from "@/lib/file-name";
import { prisma } from "@/lib/prisma";
import { loadProfileName } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";

import { renderPdf } from "./render";

// The documents Dossier makes PDFs of (RES-5, APP-12): the base resume, and
// an application's tailored resume and cover letter, printed from their
// print pages and named with Settings → PDF file name (SET-8). The Download
// PDF buttons (src/app/api/pdf) and the Claude connector's export_pdf
// (src/lib/connector/tools/documents.ts) both render them here.

/** A document with a PDF, as `?doc=` names it: the base resume, or an application's tailored resume or cover letter. */
export type PdfDocument = "base" | "resume" | "letter";

/** The tailored documents, by their `doc=` value. */
const TAILORED = { resume: DocumentKind.RESUME, letter: DocumentKind.COVER_LETTER } as const;

/** Application ids are cuids; anything else never reaches a print path. */
const APPLICATION_ID = /^[a-z0-9]{1,64}$/i;

/** A document's PDF with its file name, or why there's none to make. A tailored one names its application. */
export async function renderDocumentPdf(doc: PdfDocument, applicationId = ""): Promise<{ pdf: Uint8Array; fileName: string } | { error: string }> {
  const [name, settings] = await Promise.all([loadProfileName(), loadSettings()]);
  const date = new Date();

  if (doc === "base") {
    return {
      pdf: await renderPdf("/print/base"),
      fileName: resolveFileName(settings.fileNamePattern, { name, doc: DocumentKind.RESUME, date }),
    };
  }

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
