import "server-only";

import { z } from "zod";

import { DocumentKind, VersionCause } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { translateDocument } from "@/lib/ai/tasks";
import { SIGN_OFF_UNIT, trimmedSchema, unitsSchema, type Unit } from "@/lib/application-data";
import { documentLabels, languagesLine } from "@/lib/document-labels";
import { updateDocuments } from "@/lib/document-units";
import { saveVersion } from "@/lib/document-versions";
import { PRIVATE_FRAME_UNITS } from "@/lib/letter-frame";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { TONES } from "@/lib/tones";
import { isPublicationUnit, unitName } from "@/lib/unit-text";

import { defineJob } from "./runner";

/** The key of an application's rewrites in another language, to find one again after a reload. */
export const languageJobKey = (applicationId: string) => `language:${applicationId}`;

/** The resume's line of languages with their levels: written from the profile, in the new language, not by the model. */
const LANGUAGES_UNIT = "languages";

const ORDER = [DocumentKind.RESUME, DocumentKind.COVER_LETTER, DocumentKind.EMAIL] as const;

const STEPS: Record<(typeof ORDER)[number], string> = {
  [DocumentKind.RESUME]: "Rewriting the resume",
  [DocumentKind.COVER_LETTER]: "Rewriting the cover letter",
  [DocumentKind.EMAIL]: "Rewriting the email",
};

/** Marks the id of a part left out of the resume, which is written with the rest. */
const CUT = "#left-out";

type Cut = { index: number; unit: Unit };

/**
 * The resume's parts left out (to fit the page limit, or by hand) as parts to
 * write too: "Put back" would otherwise bring the old language back into the
 * new one. Their ids can't clash with a part of the resume.
 */
function leftOutParts(raw: unknown): [string, Cut][] {
  const parsed = trimmedSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.flatMap((item, index) => {
    const unit: Unit = item.kind === "unit" ? item.unit : { id: item.unitId, label: item.label, text: item.lines.join("\n") };
    return translatable(DocumentKind.RESUME, unit) ? [[`${unit.id}${CUT}${index}`, { index, unit }] as [string, Cut]] : [];
  });
}

/**
 * The parts of a document the model writes in another language. A
 * publication is the candidate's own citation (#218), the letter's sender and
 * signature hold contact details that never go to a model (E8-11), and the
 * email's recipient is an address.
 */
function translatable(kind: (typeof ORDER)[number], unit: Unit): boolean {
  if (!unit.text.trim()) return false;
  switch (kind) {
    case DocumentKind.RESUME:
      return !isPublicationUnit(unit.id) && unit.id !== LANGUAGES_UNIT;
    case DocumentKind.COVER_LETTER:
      return !PRIVATE_FRAME_UNITS.has(unit.id);
    case DocumentKind.EMAIL:
      return unit.id === "subject" || unit.id === "body";
  }
}

/**
 * Saves what the resume's left-out parts now say in the language, as Put back
 * will bring them. One the model skipped, or that was changed meanwhile, stays
 * as it was. Written after the document itself, as leaving a part out is.
 */
async function rewriteLeftOut(applicationId: string, cut: Map<string, Cut>, texts: Map<string, string>): Promise<string[]> {
  const row = await prisma.document.findUnique({ where: { applicationId_kind: { applicationId, kind: DocumentKind.RESUME } }, select: { id: true, trimmed: true } });
  const parsed = trimmedSchema.safeParse(row?.trimmed);
  if (!row || !parsed.success) return [];
  const left: string[] = [];
  let changed = false;
  const trimmed = parsed.data.map((item, index) => {
    const found = [...cut].find(([, value]) => value.index === index);
    if (!found) return item;
    const [id, { unit }] = found;
    const now = item.kind === "unit" ? item.unit.text : item.lines.join("\n");
    const text = texts.get(id);
    const lines = text?.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
    if (text === undefined || now !== unit.text || lines.length === 0) {
      left.push(unitName(unit));
      return item;
    }
    changed = true;
    return item.kind === "unit" ? { ...item, unit: { ...item.unit, text } } : { ...item, lines };
  });
  if (changed) await prisma.document.update({ where: { id: row.id }, data: { trimmed } });
  return left;
}

/**
 * "Rewrite in…": the application's resume, cover letter and email written
 * again in another language, and the application's language set to it, so the
 * headings and dates follow. The text is saved as a new version of each
 * document, so the earlier one is still in its history. A part edited while
 * the model was working keeps the edit.
 */
export const translateDocumentsJob = defineJob({
  type: "translate-documents",
  input: z.object({
    applicationId: z.string().min(1),
    /** A language from the "Write documents in" list, as it is spelled there. */
    language: z.string().min(1).max(100),
  }),
  result: z.object({
    language: z.string(),
    /** How many parts are now in the language. */
    rewritten: z.number().int().min(0),
    /** The parts left as they were: the model skipped them, or they were edited meanwhile. */
    left: z.array(z.string()),
  }),
  async run({ applicationId, language }, { step, signal }) {
    const application = await prisma.application.findUnique({ where: { id: applicationId }, include: { documents: true } });
    if (!application) return { language, rewritten: 0, left: [] };
    const [provider, options, profile] = await Promise.all([getAiProvider(), loadTaskOptions(), loadProfile()]);

    const asked: { kind: (typeof ORDER)[number]; units: Unit[]; texts: Map<string, string> }[] = [];
    const cut = new Map<string, Cut>();
    for (const kind of ORDER) {
      const row = application.documents.find((document) => document.kind === kind);
      const parsed = unitsSchema.safeParse(row?.units);
      const units = parsed.success ? parsed.data.filter((unit) => translatable(kind, unit)) : [];
      if (kind === DocumentKind.RESUME) {
        for (const [id, part] of leftOutParts(row?.trimmed)) {
          cut.set(id, part);
          units.push({ ...part.unit, id });
        }
      }
      if (units.length === 0) continue;
      await step(STEPS[kind]);
      const { data } = await translateDocument(provider, { kind, language, units }, { ...options, language, signal });
      asked.push({ kind, units, texts: new Map(data.translated.map((part) => [part.id, part.text])) });
    }

    await step("Saving");
    // An English letter's sign-off is the tone's own.
    const english = /^english$/i.test(language);
    // Choosing the language the application is set to, for text that isn't in it, leaves what is already right alone.
    const changing = application.language.trim().toLocaleLowerCase() !== language.toLocaleLowerCase();
    const outcome = await updateDocuments(
      applicationId,
      async (documents, tx) => {
        // What each document says now, before the rewrite changes it in place.
        const before = asked.map(({ kind }) => ({ kind, units: (documents[kind] ?? []).map((unit) => ({ ...unit })) }));
        let rewritten = 0;
        const left: string[] = [];
        for (const { kind, units, texts } of asked) {
          for (const unit of units) {
            const current = documents[kind]?.find((entry) => entry.id === unit.id);
            if (!current) continue;
            const text = texts.get(unit.id);
            // Left as it was: the model skipped it, or it was edited meanwhile, which wins.
            if (text === undefined || current.text !== unit.text) {
              left.push(unitName(current));
              continue;
            }
            current.text = english && changing && current.id === SIGN_OFF_UNIT ? TONES[application.tone].signOff : text;
            rewritten += 1;
          }
        }
        // Only when the text moved: otherwise the headings would say one language and the text another.
        if (rewritten > 0) {
          // Edits by hand live only in the current text: when it isn't the newest version, it is saved first, so what the rewrite replaces can be brought back.
          for (const { kind, units: live } of before) {
            const row = await tx.document.findUnique({
              where: { applicationId_kind: { applicationId, kind } },
              select: { id: true, versions: { orderBy: { createdAt: "desc" }, take: 1, select: { units: true } } },
            });
            const newest = unitsSchema.safeParse(row?.versions[0]?.units);
            const same = newest.success && newest.data.length === live.length && newest.data.every((unit, index) => unit.id === live[index].id && unit.text === live[index].text);
            if (row && !same) await saveVersion(tx, row.id, live, { cause: VersionCause.REFINED, detail: `Before rewriting in ${language}` });
          }
          const line = documents[DocumentKind.RESUME]?.find((entry) => entry.id === LANGUAGES_UNIT);
          if (line && changing) line.text = languagesLine(profile.languages, documentLabels(language));
          await tx.application.update({ where: { id: applicationId }, data: { language } });
        }
        return { language, rewritten, left };
      },
      { version: { cause: VersionCause.REFINED, detail: `Rewritten in ${language}` } },
    );
    if (outcome.rewritten > 0 && cut.size > 0) {
      outcome.left.push(...(await rewriteLeftOut(applicationId, cut, asked.find((entry) => entry.kind === DocumentKind.RESUME)?.texts ?? new Map())));
    }
    return outcome;
  },
});

export type TranslateDocumentsResult = z.infer<typeof translateDocumentsJob.result>;
