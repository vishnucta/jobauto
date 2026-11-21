import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { DocumentKind, VersionCause } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { trimmedSchema, unitsSchema, type Unit } from "@/lib/application-data";
import { PART_GONE } from "@/lib/document-edits";
import { updateDocuments } from "@/lib/document-units";
import { saveVersion } from "@/lib/document-versions";
import { prisma } from "@/lib/prisma";

// A tailored document's history (E8-10, APP-13): its versions, one of them
// to look at, and bringing one back, from the History panel (Undo and "Go
// back to this", E30-11) and from the Claude connector
// (src/lib/connector/tools/documents.ts).
// src/lib/document-versions.ts saves them. A refusal is an ActionError,
// written for the user.

const VERSION_GONE = "That version no longer exists. Open the history again to see what's there.";

export type VersionLine = { id: string; cause: VersionCause; detail: string; createdAt: string };

/** A document's versions, newest first, without their units. */
export async function listDocumentVersions(applicationId: string, document: DocumentKind): Promise<VersionLine[]> {
  const versions = await prisma.documentVersion.findMany({
    where: { document: { applicationId, kind: document } },
    orderBy: { createdAt: "desc" },
    select: { id: true, cause: true, detail: true, createdAt: true },
  });
  return versions.map((version) => ({ ...version, createdAt: version.createdAt.toISOString() }));
}

/** One version's units, to look at before restoring it. */
export async function loadDocumentVersion(applicationId: string, versionId: string): Promise<{ document: DocumentKind; units: Unit[] }> {
  const version = await prisma.documentVersion.findFirst({
    where: { id: versionId, document: { applicationId } },
    select: { units: true, document: { select: { kind: true } } },
  });
  if (!version) throw new ActionError(VERSION_GONE);
  return { document: version.document.kind, units: unitsSchema.parse(version.units) };
}

/**
 * Brings back an earlier version and returns which document it's of. The
 * document as it is now is saved as a version first (unless it's already
 * the newest), so nothing is lost, and the restored state becomes a version
 * of its own.
 */
export async function restoreDocumentVersion(applicationId: string, versionId: string): Promise<DocumentKind> {
  return (await bringBack(applicationId, versionId))!;
}

/**
 * Undo on the latest change, and "Go back to this" on an older one
 * (E30-11, AP2): brings back each version given, one per document, as a
 * new version. A document that already reads so is left as it is. Returns
 * the documents that changed.
 */
export async function goBackToVersions(applicationId: string, versionIds: readonly string[]): Promise<DocumentKind[]> {
  const changed: DocumentKind[] = [];
  for (const versionId of versionIds) {
    const kind = await bringBack(applicationId, versionId, { same: "skip" });
    if (kind) changed.push(kind);
  }
  if (changed.length === 0) throw new ActionError("That's how it is now already.");
  return changed;
}

/** restoreDocumentVersion(), or null when it's the version there now and `same` says to skip it. */
async function bringBack(applicationId: string, versionId: string, { same = "refuse" }: { same?: "refuse" | "skip" } = {}): Promise<DocumentKind | null> {
  const version = await prisma.documentVersion.findFirst({
    where: { id: versionId, document: { applicationId } },
    select: { units: true, createdAt: true, document: { select: { id: true, kind: true } } },
  });
  if (!version) throw new ActionError(VERSION_GONE);
  const { kind } = version.document;
  const units = unitsSchema.parse(version.units);

  let skipped = false;
  const stillLeftOut = await updateDocuments(
    applicationId,
    async (documents, tx) => {
      const current = documents[kind];
      if (!current) throw new ActionError(PART_GONE);
      if (JSON.stringify(current) === JSON.stringify(units)) {
        if (same === "skip") {
          skipped = true;
          return null;
        }
        throw new ActionError("That's the version you have now.");
      }
      const newest = await tx.documentVersion.findFirst({ where: { documentId: version.document.id }, orderBy: { createdAt: "desc" }, select: { units: true } });
      if (!newest || JSON.stringify(unitsSchema.parse(newest.units)) !== JSON.stringify(current)) {
        await saveVersion(tx, version.document.id, current, { cause: VersionCause.BEFORE_RESTORE });
      }
      documents[kind] = units;
      // Parts left out that the restored version has again are no longer left out.
      if (kind !== DocumentKind.RESUME) return null;
      const row = await tx.document.findUniqueOrThrow({ where: { id: version.document.id }, select: { trimmed: true } });
      const trimmed = trimmedSchema.safeParse(row.trimmed);
      if (!trimmed.success) return null;
      return trimmed.data.filter((cut) =>
        cut.kind === "unit"
          ? !units.some((unit) => unit.id === cut.unit.id)
          : !cut.lines.every((line) => units.find((unit) => unit.id === cut.unitId)?.text.includes(line)),
      );
    },
    { version: { cause: VersionCause.RESTORED, detail: version.createdAt.toISOString() } },
  );
  if (skipped) return null;
  // Written after the document itself: updateDocuments checks it wasn't changed meanwhile.
  if (stillLeftOut) {
    await prisma.document.update({
      where: { id: version.document.id },
      data: { trimmed: stillLeftOut.length > 0 ? stillLeftOut : Prisma.DbNull },
    });
  }
  return kind;
}
