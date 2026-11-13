import type { Metadata } from "next";

import { ResumeDocument } from "@/components/documents/resume-document";
import { DocumentKind } from "@/generated/prisma/enums";
import { printBasePath } from "@/lib/pdf/pages";
import { verifyPrintAccess } from "@/lib/pdf/print-access";
import { printMetadata } from "@/lib/pdf/print-title";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { loadTheme } from "@/lib/theme-data";
import { BUILT_IN_THEMES, FIT_LEVELS, printCss } from "@/lib/themes";

export async function generateMetadata({ searchParams }: PageProps<"/print/base">): Promise<Metadata> {
  await verifyPrintAccess(printBasePath(fitLevel((await searchParams).fit)));
  return printMetadata(DocumentKind.RESUME);
}

/**
 * The base resume on its own, for the PDF renderer (E5-5) to print.
 * `?fit=1` to `?fit=4` squeeze it that far, for "Fit to one page" (public
 * issue 69): the renderer tries the levels in turn until it fits.
 */
export default async function PrintBaseResumePage({ searchParams }: PageProps<"/print/base">) {
  const fit = fitLevel((await searchParams).fit);
  await verifyPrintAccess(printBasePath(fit));
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  const theme = (await loadTheme(settings.baseThemeId)) ?? BUILT_IN_THEMES[0];

  return (
    <>
      <style>{printCss(theme, settings.paper, fit)}</style>
      <ResumeDocument theme={theme} profile={profile} paper={settings.paper} includeReferences={settings.includeRefs} sections={settings.resumeSections} language={settings.resumeLanguage} fit={fit} />
    </>
  );
}

const fitLevel = (value: string | string[] | undefined) => {
  const level = Number(typeof value === "string" ? value : 0);
  return Number.isInteger(level) && level > 0 ? Math.min(level, FIT_LEVELS) : 0;
};
