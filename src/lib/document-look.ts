import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { DOCUMENT_LANGUAGES } from "@/lib/document-language";
import { prisma } from "@/lib/prisma";
import { loadSettings } from "@/lib/settings-data";

// How an application's tailored resume and cover letter look: their theme
// (#226), on the resume, the profile photo (#224) and the theme's own
// layout (APP-4), and the language their headings and dates are in. Only
// their look changes, so nothing is written again. The Resume and Cover
// letter tabs and the Claude connector (src/lib/connector/tools/documents.ts)
// both change it here. A refusal is an ActionError, written for the user.

const GONE = "That application no longer exists.";

export type DocumentLook = {
  /** A theme for the resume and the cover letter, together. */
  themeId?: string;
  /** The profile photo on this resume or not, whatever the profile says. */
  showPhoto?: boolean;
  /** The theme's own layout, or a single column. */
  followThemeLayout?: boolean;
  /** The language the documents are written in ("German"), which their headings and dates follow: one from the "Write documents in" list, or one added there. */
  language?: string;
};

/** Changes what `look` names; the rest stays as it is. */
export async function setDocumentLook(applicationId: string, { themeId, showPhoto, followThemeLayout, language }: DocumentLook): Promise<void> {
  // Checked before anything is written, so a refused language leaves the theme as it was too.
  const languageName = language === undefined ? undefined : await knownLanguageName(language);
  if (themeId !== undefined) {
    if (!(await prisma.theme.count({ where: { id: themeId } }))) {
      throw new ActionError("That theme doesn't exist anymore. Reload the page to see your themes.");
    }
    if (!(await prisma.application.count({ where: { id: applicationId } }))) throw new ActionError(GONE);
    await prisma.document.updateMany({
      where: { applicationId, kind: { in: [DocumentKind.RESUME, DocumentKind.COVER_LETTER] } },
      data: { themeId },
    });
  }
  if (showPhoto !== undefined || followThemeLayout !== undefined || languageName !== undefined) {
    const { count } = await prisma.application.updateMany({ where: { id: applicationId }, data: { showPhoto, followThemeLayout, language: languageName } });
    if (count === 0) throw new ActionError(GONE);
  }
}

/**
 * A language as the list spells it ("german" is "German"), or a refusal:
 * the headings and dates come from the language, so it must be one Dossier
 * knows, built in or added in Settings → Documents (SET-7).
 */
export async function knownLanguageName(language: string): Promise<string> {
  const wanted = language.trim();
  if (!wanted) throw new ActionError("Say which language the documents are written in.");
  const { customLanguages } = await loadSettings();
  const names = [...DOCUMENT_LANGUAGES.map((entry) => entry.name), ...customLanguages];
  const found = names.find((name) => name.toLocaleLowerCase() === wanted.toLocaleLowerCase());
  if (!found) throw new ActionError(`Dossier doesn't know the language "${wanted}". The languages are ${names.join(", ")}; add another in Settings → Documents with “Other language…”.`);
  return found;
}
