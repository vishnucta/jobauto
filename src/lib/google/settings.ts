import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { saveSettings } from "@/lib/settings-data";

// Settings → Google (E15-1): the inbox and calendar settings, from the
// settings screen and from Claude (#221). The OAuth client is saved on its
// own, since its secret never comes back.

/** What each switch and field saves; each saves on its own, so all are optional. */
export const googleSettingsSchema = z.strictObject({
  gmailRead: z.boolean().optional(),
  gmailScope: z.enum(["known", "all"]).optional(),
  gmailInterval: z.number().int().min(5).max(120).optional(),
  calendarAvailability: z.boolean().optional(),
  calendarEvents: z.boolean().optional(),
  calendarId: z.string().trim().min(1).max(300).optional(),
  workDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  workTimeZone: z
    .string()
    .trim()
    .max(100)
    .refine((zone) => {
      if (!zone) return true;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "That isn't a time zone.")
    .optional(),
  slotMinutes: z.number().int().min(15).max(240).optional(),
  bufferMinutes: z.number().int().min(0).max(120).optional(),
});

export type GoogleSettingsChange = z.output<typeof googleSettingsSchema>;

/** Saves what changed: working days once each and in order, and an empty time zone as "the browser's". */
export async function saveGoogleSettingChanges({ workTimeZone, workDays, ...changes }: GoogleSettingsChange): Promise<void> {
  if (changes.workStart && changes.workEnd && changes.workStart >= changes.workEnd) throw new ActionError("The working day has to end after it starts.");
  await saveSettings({
    ...changes,
    ...(workDays ? { workDays: [...new Set(workDays)].sort() } : {}),
    ...(workTimeZone === undefined ? {} : { workTimeZone: workTimeZone || null }),
  });
}
