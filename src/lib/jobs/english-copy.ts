import "server-only";

import { z } from "zod";

import { DocumentKind } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { translateDocument } from "@/lib/ai/tasks";
import { unitsSchema } from "@/lib/application-data";
import { withoutPrivateParts } from "@/lib/letter-frame";
import { prisma } from "@/lib/prisma";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";

/** The key of a document's English copy being written, so a second click finds it. */
export const englishCopyJobKey = (applicationId: string, kind: DocumentKind) => `english-copy:${applicationId}:${kind}`;

/**
 * An English copy of a document written in another language (jobauto fork),
 * for her to read what she sends: never saved in the document, never sent.
 * The sender and signature, which hold contact details, stay out of it.
 */
export const englishCopyJob = defineJob({
  type: "english-copy",
  input: z.object({ applicationId: z.string().min(1), kind: z.enum(DocumentKind) }),
  result: z.object({ parts: z.array(z.object({ label: z.string(), text: z.string() })) }),
  async run({ applicationId, kind }, { step, signal }) {
    await step("Writing it in English");
    const document = await prisma.document.findUnique({ where: { applicationId_kind: { applicationId, kind } }, select: { units: true } });
    const units = unitsSchema.safeParse(document?.units);
    if (!units.success) throw new Error("The document isn't there any more.");
    const parts = withoutPrivateParts(units.data).filter((unit) => unit.text.trim());
    const [provider, options] = await Promise.all([getAiProvider(), loadTaskOptions()]);
    const { data } = await translateDocument(provider, { kind, language: "English", units: parts }, { ...options, language: "English", signal });
    const byId = new Map(data.translated.map((entry) => [entry.id, entry.text]));
    return { parts: parts.map((unit) => ({ label: unit.label, text: byId.get(unit.id) ?? unit.text })) };
  },
});

/** Read in English: one being written is reused. */
export async function startEnglishCopy(applicationId: string, kind: DocumentKind): Promise<string> {
  const [unfinished] = await findUnfinishedJobs(englishCopyJobKey(applicationId, kind));
  if (unfinished) return unfinished.id;
  return startJob(englishCopyJob, { applicationId, kind }, { key: englishCopyJobKey(applicationId, kind), applicationId });
}
