"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { startWorkSample } from "@/lib/jobs/write-work-sample";
import { prisma } from "@/lib/prisma";
import { workSampleOf } from "@/lib/work-sample";

// The Work sample tab's actions (jobauto fork).

/** "Write my first 90 days", or "Write it again": starts the job and returns it to follow. */
export const writeWorkSample = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError("That application no longer exists.");
  if (!(await isAiUsable())) throw new ActionError("Set up an AI provider in Settings → AI provider first.");
  return startWorkSample(id);
});

/** Whether the work sample goes after the resume in the Bewerbungsmappe. */
export const putWorkSampleInMappe = action(z.object({ id: z.string().min(1), inMappe: z.boolean() }), async ({ id, inMappe }) => {
  const application = await prisma.application.findUnique({ where: { id }, select: { workSample: true } });
  const sample = workSampleOf(application?.workSample);
  if (!sample) throw new ActionError("Write the work sample first.");
  await prisma.application.update({ where: { id }, data: { workSample: { ...sample, inMappe } } });
  revalidatePath(`/applications/${id}`);
  return { inMappe };
});
