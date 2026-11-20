import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { WorkSampleDocument } from "@/components/documents/work-sample-document";
import { DocumentKind } from "@/generated/prisma/enums";
import { verifyPrintAccess } from "@/lib/pdf/print-access";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";
import { loadTheme } from "@/lib/theme-data";
import { BUILT_IN_THEMES, printCss } from "@/lib/themes";
import { workSampleOf } from "@/lib/work-sample";

export const metadata: Metadata = { title: "Work sample", robots: { index: false } };

/** An application's work sample on its own (jobauto fork), for the PDF renderer to print, in the cover letter's theme. */
export default async function PrintWorkSamplePage({ params }: PageProps<"/print/sample/[id]">) {
  const { id } = await params;
  await verifyPrintAccess(`/print/sample/${id}`);
  const [application, settings, name] = await Promise.all([
    prisma.application.findUnique({ where: { id }, select: { workSample: true, language: true, documents: { where: { kind: DocumentKind.COVER_LETTER }, select: { themeId: true } } } }),
    loadSettings(),
    prisma.profileField.findUnique({ where: { key: "name" }, select: { value: true } }),
  ]);
  const sample = workSampleOf(application?.workSample);
  if (!application || !sample) notFound();
  const theme = (await loadTheme(application.documents[0]?.themeId ?? settings.baseThemeId)) ?? BUILT_IN_THEMES[0];
  return (
    <>
      <style>{printCss(theme, settings.paper)}</style>
      <WorkSampleDocument sample={sample} name={name?.value ?? ""} theme={theme} paper={settings.paper} language={application.language} />
    </>
  );
}
