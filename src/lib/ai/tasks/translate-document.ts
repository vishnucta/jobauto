import { z } from "zod";

import { DocumentKind } from "@/generated/prisma/enums";
import type { Unit } from "@/lib/application-data";
import { bulletLines, isBulletUnit, plainText } from "@/lib/unit-text";

import { system, type Task } from "./prompt-parts";

export const TRANSLATE_DOCUMENT_VERSION = "translate-document@1";

const answerSchema = z.object({ parts: z.array(z.object({ unitId: z.string(), text: z.string() })) });

/** What each document is called in the prompt. */
const DOCUMENT_NAMES: Record<DocumentKind, string> = {
  [DocumentKind.RESUME]: "resume",
  [DocumentKind.COVER_LETTER]: "cover letter",
  [DocumentKind.EMAIL]: "application email",
};

export type TranslateInput = {
  kind: DocumentKind;
  /** The language to write in, e.g. "German". */
  language: string;
  /** The parts to write in it, whole, with the ids the answer points at. */
  units: Unit[];
};

/** The parts that came back in the language, and the ids of those that didn't. */
export type Translation = { translated: { id: string; text: string }[]; missing: string[] };

/**
 * A document's parts written again in another language, the rest left alone
 * ("Rewrite in…"): the same facts in the same order and about the same
 * length, not a new draft. A part the model leaves out, or answers with
 * nothing, comes back in `missing` and stays as it was.
 */
export const translateDocument: Task<TranslateInput, Translation> = async (provider, { kind, language, units }, options) => {
  const what = DOCUMENT_NAMES[kind];
  const answer = await provider.complete({
    system: system(
      `You write a candidate's ${what} again in ${language}, as JSON: one entry for each part you are given, with its unitId and its whole text in ${language}. It is the same ${what}, in another language for another reader.`,
      [
        `- Translate; don't write something new. Keep the meaning, the order, the facts and about the length of each part. Don't add, drop, soften or embellish anything.`,
        `- Keep exactly as they are: numbers, amounts, the names of people, companies, products, tools, schools and certifications, and email and web addresses.`,
        `- Write dates, and the months in them, the way ${language} writes them, for the same day.`,
        `- A job title or technical term takes the form employers use in ${language}. Where employers there use the English term, keep it.`,
        `- A part written as bullets, one per line, stays that: the same number of bullets, one per line, without bullet characters. Keep paragraph breaks.`,
        `- A part that is already in ${language} comes back as it is.`,
        `- Write as a native speaker would write a ${what}, in the same tone as the original.`,
      ].join("\n"),
    ),
    messages: [
      {
        role: "user",
        content: `Write these parts of the ${what} in ${language}:\n${JSON.stringify(
          units.map((unit) => ({ unitId: unit.id, part: unit.label, text: unit.text })),
          null,
          2,
        )}`,
      },
    ],
    schema: answerSchema,
    schemaName: "translated_parts",
    // A translation follows the original; it isn't the place for the model's own phrasing.
    creativity: "FAITHFUL",
    signal: options.signal,
  });

  const given = new Set(units.map((unit) => unit.id));
  const translated: Translation["translated"] = [];
  for (const part of answer.parts) {
    if (!given.has(part.unitId) || translated.some((entry) => entry.id === part.unitId)) continue;
    const text = isBulletUnit(part.unitId) ? bulletLines(part.text) : plainText(part.text).trim();
    if (text) translated.push({ id: part.unitId, text });
  }
  return {
    data: { translated, missing: units.filter((unit) => !translated.some((entry) => entry.id === unit.id)).map((unit) => unit.id) },
    promptVersion: TRANSLATE_DOCUMENT_VERSION,
  };
};
