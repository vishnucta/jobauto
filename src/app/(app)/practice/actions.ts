"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { startPractice } from "@/lib/jobs/prepare-practice";

// Interview practice's action (jobauto fork).

/** "Prepare my practice call", or "Prepare again": starts the job and returns it to follow. */
export const preparePractice = action(z.object({}), async () => {
  if (!(await isAiUsable())) throw new ActionError("Set up an AI provider in Settings → AI provider first.");
  return startPractice();
});
