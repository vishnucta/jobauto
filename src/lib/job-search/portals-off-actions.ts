"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action } from "@/lib/action";
import { saveSettings } from "@/lib/settings-data";

/** "Dismiss" on the note about portals with a key that are off (jobauto fork): it doesn't come back. */
export const dismissPortalsOffNote = action(z.object({}), async () => {
  await saveSettings({ portalsOffNoteDone: true });
  revalidatePath("/jobs");
  revalidatePath("/settings");
  return null;
});
