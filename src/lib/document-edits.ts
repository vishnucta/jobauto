import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { trimmedSchema, type Trimmed } from "@/lib/application-data";
import { updateDocuments } from "@/lib/document-units";
import { isFrameUnit, withFrame } from "@/lib/letter-frame";
import { prisma } from "@/lib/prisma";
import { cleanUnitText } from "@/lib/unit-text";

// Changes to a tailored document's units that need no AI: an edit by hand
// (E8-3) and leaving a part of the resume out or putting it back (E10-10,
// #217). The application's page (src/app/(app)/applications/[id]/actions.ts)
// and the Claude connector (src/lib/connector/tools/documents.ts) both make
// them here. A refusal is an ActionError, written for the user.

export const PART_GONE = "That part of the document no longer exists. Reload the page to see what's there now.";

/**
 * Saves a unit edited by hand (APP-6) and returns its text as saved.
 * `expected` is the text the editor started from: if the unit changed since
 * (an AI rewrite that finished meanwhile), nothing is saved, so neither
 * version is lost unseen. The text is the user's own, so the fact guard's
 * hints go, unless it was written in Claude (#221) and comes with its own.
 */
export async function saveUnitText({
  applicationId,
  document,
  unitId,
  text,
  expected,
  unverified,
}: {
  applicationId: string;
  document: DocumentKind;
  unitId: string;
  text: string;
  expected: string;
  /** What the fact guard couldn't back in a text written in Claude. */
  unverified?: string[];
}): Promise<string> {
  const clean = cleanUnitText(unitId, text);
  // The email's recipient may be left empty, for the mail app to fill in.
  if (!clean && !(document === DocumentKind.EMAIL && unitId === "to")) {
    throw new ActionError("Write something first, or cancel to keep it as it was.");
  }

  await updateDocuments(applicationId, async (documents) => {
    const units = documents[document];
    const unit = units?.find((entry) => entry.id === unitId);
    // A letter written before E8-11 shows its frame without storing it: the first edit stores that part.
    if (!unit && units && document === DocumentKind.COVER_LETTER && isFrameUnit(unitId)) {
      documents[document] = withFrame(units, { [unitId]: clean });
      return;
    }
    if (!unit) throw new ActionError(PART_GONE);
    if (unit.text !== expected) {
      throw new ActionError("This part changed while you were editing it. Copy your text, cancel, and edit the new version.");
    }
    unit.text = clean;
    if (unverified?.length) unit.unverified = unverified;
    else delete unit.unverified;
  });
  return clean;
}

/**
 * "Leave out" (#217): takes a part off the tailored resume. It's listed with
 * what the page limit left out, so "Put back" brings it back to its place.
 * Returns where it is in that list, for Undo.
 */
export async function leaveOut(applicationId: string, unitId: string): Promise<number> {
  const cut = await updateDocuments(applicationId, async (documents) => {
    const units = documents[DocumentKind.RESUME];
    const index = units ? units.findIndex((unit) => unit.id === unitId) : -1;
    if (!units || index < 0) throw new ActionError(PART_GONE);
    const [unit] = units.splice(index, 1);
    return { kind: "unit" as const, unit, index, byHand: true as const };
  });
  // Written after the document itself: updateDocuments checks it wasn't changed meanwhile.
  const row = await prisma.document.findUniqueOrThrow({
    where: { applicationId_kind: { applicationId, kind: DocumentKind.RESUME } },
    select: { id: true, trimmed: true },
  });
  const earlier = trimmedSchema.safeParse(row.trimmed);
  const trimmed = [...(earlier.success ? earlier.data : []), cut];
  await prisma.document.update({ where: { id: row.id }, data: { trimmed } });
  return trimmed.length - 1;
}

/**
 * "Put back" (E10-10, #217): restores a part or bullets left out, by hand or
 * to fit the page limit, and returns what it put back. Putting back twice
 * changes nothing more.
 */
export async function putBack(applicationId: string, index: number): Promise<Trimmed[number]> {
  const row = await prisma.document.findUnique({ where: { applicationId_kind: { applicationId, kind: DocumentKind.RESUME } } });
  const trimmed = row ? trimmedSchema.safeParse(row.trimmed) : null;
  const item = trimmed?.success ? trimmed.data[index] : undefined;
  if (!row || !trimmed?.success || !item) throw new ActionError("That's already back. Reload the page to see the resume as it is.");

  await updateDocuments(applicationId, async (documents) => {
    const units = documents[DocumentKind.RESUME];
    if (!units) throw new ActionError(PART_GONE);
    if (item.kind === "unit") {
      if (!units.some((unit) => unit.id === item.unit.id)) units.splice(Math.min(item.index, units.length), 0, item.unit);
      return;
    }
    const unit = units.find((entry) => entry.id === item.unitId);
    if (!unit) throw new ActionError(PART_GONE);
    const lines = unit.text.split("\n");
    unit.text = [...lines, ...item.lines.filter((line) => !lines.includes(line))].filter(Boolean).join("\n");
  });
  const rest = trimmed.data.filter((_, position) => position !== index);
  await prisma.document.update({ where: { id: row.id }, data: { trimmed: rest.length > 0 ? rest : Prisma.DbNull } });
  return item;
}
