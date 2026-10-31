import "server-only";

import { ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";
import type { FactItem } from "@/lib/profile";
import { nextSort } from "@/lib/profile-entries";

// Facts the user tells the AI (PRO-14, APP-15): the profile's own when
// applicationId is null, else one application's. Their Server Actions
// (src/lib/fact-actions.ts) and the Claude connector's tools add them here.

/** Plenty for one person or one application, and still a prompt a local model can take. */
export const MAX_FACTS = 50;

/** Refuses a fact for an application that's gone, or one more than MAX_FACTS. */
export async function checkFactRoom(applicationId: string | null): Promise<void> {
  if (applicationId && !(await prisma.application.findUnique({ where: { id: applicationId }, select: { id: true } }))) {
    throw new ActionError("This application doesn't exist any more.");
  }
  if ((await prisma.fact.count({ where: { applicationId } })) >= MAX_FACTS) {
    throw new ActionError(`That's ${MAX_FACTS} facts already. Remove one you no longer need first.`);
  }
}

/** Adds a fact after the others: blank, as "Add a fact" does, unless `text` is given. */
export async function addFact(applicationId: string | null, text = ""): Promise<FactItem> {
  await checkFactRoom(applicationId);
  return prisma.fact.create({ data: { applicationId, text, sort: await nextSort(prisma.fact) }, select: { id: true, text: true } });
}
