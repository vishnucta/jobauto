"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action } from "@/lib/action";
import { applyAnswersSchema } from "@/lib/apply/answers";
import { saveSettings } from "@/lib/settings-data";

// Settings → Standard answers (jobauto fork): the one place the answers
// every application uses are edited. The Apply tab shows them, read-only.

/** Saves the standard answers, for every application from now on. */
export const saveStandardAnswers = action(z.object({ answers: applyAnswersSchema }), async ({ answers }, { toast }) => {
  await saveSettings({ applyAnswers: answers });
  // Every application's Apply tab shows them.
  revalidatePath("/applications", "layout");
  toast("Saved. They're used for every application.");
  return null;
});
