"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action } from "@/lib/action";
import { eraseApplication, setApplicationArchived } from "@/lib/application-lifecycle";

// Archiving and deleting an application (E9-5, LST-8), from its page, a
// card or a table row. The work is in src/lib/application-lifecycle.ts,
// which the Claude connector shares.

// The list, the dashboard and the application all show it.
const refreshEverything = () => revalidatePath("/", "layout");

/**
 * Archives an application, or brings it back. Archived ones leave the board
 * but still count on the dashboard. Tidying up isn't news, so "Updated"
 * stays as it was.
 */
export const setArchived = action(z.object({ id: z.string().min(1), archived: z.boolean() }), async ({ id, archived }) => {
  await setApplicationArchived(id, archived);
  refreshEverything();
  return null;
});

/** Deletes an application with its documents, chat, notes, history, jobs and apply runs. */
export const deleteApplication = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  await eraseApplication(id);
  refreshEverything();
  return null;
});
