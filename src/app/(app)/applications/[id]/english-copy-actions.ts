"use server";

import { z } from "zod";

import { DocumentKind } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { startEnglishCopy } from "@/lib/jobs/english-copy";
import { prisma } from "@/lib/prisma";

/** "Read in English": starts the English copy and returns the job to follow. */
export const readInEnglish = action(z.object({ id: z.string().min(1), kind: z.enum(DocumentKind) }), async ({ id, kind }) => {
  if (!(await prisma.document.count({ where: { applicationId: id, kind } }))) throw new ActionError("That document isn't there any more. Reload the page.");
  if (!(await isAiUsable())) throw new ActionError("Set up an AI provider in Settings → AI provider first.");
  return { jobId: await startEnglishCopy(id, kind) };
});
