import { type NextRequest, NextResponse } from "next/server";

import { renderDocumentPdf } from "@/lib/pdf/documents";
import { holdPdf, pdfDownload } from "@/lib/pdf/downloads";
import { route } from "@/lib/route";

const notFound = (error: string) => NextResponse.json({ error }, { status: 404 });

/**
 * Downloads a document as a PDF (RES-5, APP-12): `?doc=base` for the base
 * resume, `?doc=resume&application={id}` or `?doc=letter&application={id}`
 * for an application's tailored resume or cover letter. The file is named
 * with Settings → PDF file name (SET-8).
 */
export const GET = route(async (request) => {
  const rendered = await renderRequested(request);
  return rendered instanceof Response ? rendered : pdfDownload(rendered.pdf, rendered.fileName);
});

/**
 * Renders the same documents and holds the PDF for a few minutes, answering
 * with the link to download it from: `{ url }`. The download button uses
 * this, so the browser saves the file from a link of its own.
 */
export const POST = route(async (request) => {
  const rendered = await renderRequested(request);
  if (rendered instanceof Response) return rendered;
  return NextResponse.json({ url: `/api/pdf/${holdPdf(rendered.pdf, rendered.fileName)}` });
});

/** The PDF and file name of the document the query asks for, or a 404 response. */
async function renderRequested(request: NextRequest): Promise<{ pdf: Uint8Array; fileName: string } | Response> {
  const params = request.nextUrl.searchParams;
  const doc = params.get("doc");
  if (doc !== "base" && doc !== "resume" && doc !== "letter") return notFound("There's no such document to download.");
  const rendered = await renderDocumentPdf(doc, params.get("application") ?? "");
  return "error" in rendered ? notFound(rendered.error) : rendered;
}
