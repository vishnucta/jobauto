"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { startCallPrep } from "@/lib/jobs/prepare-call";
import { prisma } from "@/lib/prisma";

// The Call prep tab's action (jobauto fork).

/** "Prepare for the call", or "Prepare again": starts the job and returns it to follow. */
export const prepareForCall = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError("That application no longer exists.");
  if (!(await isAiUsable())) throw new ActionError("Set up an AI provider in Settings → AI provider first.");
  return startCallPrep(id);
});
