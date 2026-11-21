import type { Metadata } from "next";

import { KurzprofilDocument } from "@/components/documents/kurzprofil-document";
import { kurzprofil } from "@/lib/kurzprofil";
import { printKurzprofilPath } from "@/lib/pdf/pages";
import { verifyPrintAccess } from "@/lib/pdf/print-access";
import { loadProfile } from "@/lib/profile-data";
import { loadProfileSettings, profileIdOr } from "@/lib/profiles";
import { loadSettings } from "@/lib/settings-data";
import { loadTheme } from "@/lib/theme-data";
import { BUILT_IN_THEMES, printCss } from "@/lib/themes";

export const metadata: Metadata = { title: "Kurzprofil", robots: { index: false } };

/**
 * The Kurzprofil on its own (jobauto fork), for the PDF renderer to print:
 * a profile's, in its Base resume's theme, like the base resume (E24-2);
 * the first one's without `?profile=`.
 */
export default async function PrintKurzprofilPage({ searchParams }: PageProps<"/print/kurzprofil">) {
  const { profile: asked } = await searchParams;
  const named = typeof asked === "string" && asked ? asked : undefined;
  await verifyPrintAccess(printKurzprofilPath(named));
  const profileId = await profileIdOr(named);
  const [profile, own, settings] = await Promise.all([loadProfile(profileId), loadProfileSettings(profileId), loadSettings()]);
  const theme = (await loadTheme(own.baseThemeId)) ?? BUILT_IN_THEMES[0];
  return (
    <>
      <style>{printCss(theme, settings.paper)}</style>
      <KurzprofilDocument profile={kurzprofil(profile, settings.applyAnswers, new Date())} theme={theme} paper={settings.paper} />
    </>
  );
}
