import "server-only";

import { DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";

// How an application's tailored resume and cover letter look: their theme
// (#226), and on the resume, the profile photo (#224) and the theme's own
// layout (APP-4). Only their look changes, so nothing is written again. The
// Resume and Cover letter tabs and the Claude connector
// (src/lib/connector/tools/documents.ts) both change it here. A refusal is
// an ActionError, written for the user.

const GONE = "That application no longer exists.";

export type DocumentLook = {
  /** A theme for the resume and the cover letter, together. */
  themeId?: string;
  /** The profile photo on this resume or not, whatever the profile says. */
  showPhoto?: boolean;
  /** The theme's own layout, or a single column. */
  followThemeLayout?: boolean;
};

/** Changes what `look` names; the rest stays as it is. */
export async function setDocumentLook(applicationId: string, { themeId, showPhoto, followThemeLayout }: DocumentLook): Promise<void> {
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
  if (showPhoto !== undefined || followThemeLayout !== undefined) {
    const { count } = await prisma.application.updateMany({ where: { id: applicationId }, data: { showPhoto, followThemeLayout } });
    if (count === 0) throw new ActionError(GONE);
  }
}
