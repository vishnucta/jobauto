"use server";

import { z } from "zod";

import { action } from "@/lib/action";
import { addFact, checkFactRoom } from "@/lib/facts";
import { prisma } from "@/lib/prisma";
import { nextSort } from "@/lib/profile-entries";

// Facts the user tells the AI (PRO-14, APP-15): the profile's own when
// applicationId is null, else one application's. Added blank, autosaved as
// typed, removed at once with Undo.

const id = z.string().min(1);
const applicationId = id.nullable();
/** About a short paragraph: a fact, not a document. */
const text = z.string().max(1000);

export const createFact = action(z.object({ applicationId }), ({ applicationId }) => addFact(applicationId));

export const saveFact = action(z.object({ id, text }), async ({ id, text }) => {
  await prisma.fact.updateMany({ where: { id }, data: { text } });
  return null;
});

/** Answers with where it was, for Undo. */
export const removeFact = action(z.object({ id }), async ({ id }) => {
  const fact = await prisma.fact.findUnique({ where: { id }, select: { sort: true } });
  await prisma.fact.deleteMany({ where: { id } });
  return { sort: fact?.sort ?? null };
});

/** Undo: back with its id and text, in its old place when that's known. */
export const restoreFact = action(
  z.object({ id, applicationId, text, sort: z.number().int().nullable() }),
  async ({ id, applicationId, text, sort }) => {
    await checkFactRoom(applicationId);
    return prisma.fact.upsert({
      where: { id },
      create: { id, applicationId, text, sort: sort ?? (await nextSort(prisma.fact)) },
      update: {},
      select: { id: true, text: true },
    });
  },
);
