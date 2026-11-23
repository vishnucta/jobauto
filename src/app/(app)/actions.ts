"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { hideNote, writeNote } from "@/lib/daily-note";
import { prepareKept } from "@/lib/jobs/prepare-application";
import { saveSettings } from "@/lib/settings-data";
import { userTimeZone } from "@/lib/time-zone";

/** Remembers the dashboard's period (E9-8), for the next visit. */
export const rememberDashboardPeriod = action(z.object({ period: z.enum(["30d", "90d", "all"]) }), async ({ period }) => {
  await saveSettings({ dashboardPeriod: period });
  return null;
});

/**
 * "Prepare" on a posting in her field (Do today, jobauto fork): Prepare it
 * for me, for a posting Positions keeps. Answers with the job to follow, or
 * the application when the posting has one already.
 */
export const prepareFieldPosting = action(z.object({ postingId: z.string().min(1).max(100) }), async ({ postingId }) => {
  if (!(await isAiUsable())) throw new ActionError("Set up an AI provider in Settings → AI provider first, or open the posting and start the application step by step.");
  return prepareKept(postingId);
});

/** Days without news before Needs you suggests a follow-up (E9-9). */
export const rememberQuietDays = action(z.object({ days: z.number().int().min(1).max(60) }), async ({ days }) => {
  await saveSettings({ quietDays: days });
  return null;
});

/** Applications to send each week (weekly-target.ts); 0 turns the target off. */
export const rememberWeeklyTarget = action(z.object({ target: z.number().int().min(0).max(50) }), async ({ target }) => {
  await saveSettings({ weeklyTarget: target });
  return null;
});

/** Today's daily note (E28-6): written once after the dashboard loads, or another one, up to three a day. */
export const writeDailyNoteAction = action(z.object({ another: z.boolean() }), async ({ another }) => writeNote({ timeZone: await userTimeZone(), another }));

/** "Hide for today" on the daily note: until midnight in the user's time zone. */
export const hideDailyNote = action(z.object({}), async () => {
  await hideNote({ timeZone: await userTimeZone() });
  return null;
});
