import type { Metadata } from "next";

import { KurzprofilDocument } from "@/components/documents/kurzprofil-document";
import { kurzprofil } from "@/lib/kurzprofil";
import { verifyPrintAccess } from "@/lib/pdf/print-access";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { loadTheme } from "@/lib/theme-data";
import { BUILT_IN_THEMES, printCss } from "@/lib/themes";

export const metadata: Metadata = { title: "Kurzprofil", robots: { index: false } };

/** The Kurzprofil on its own (jobauto fork), for the PDF renderer to print. */
export default async function PrintKurzprofilPage() {
  await verifyPrintAccess("/print/kurzprofil");
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  const theme = (await loadTheme(settings.baseThemeId)) ?? BUILT_IN_THEMES[0];
  return (
    <>
      <style>{printCss(theme, settings.paper)}</style>
      <KurzprofilDocument profile={kurzprofil(profile, settings.applyAnswers, new Date())} theme={theme} paper={settings.paper} />
    </>
  );
}
