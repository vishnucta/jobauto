import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { isoInZone } from "@/lib/dates";
import { syncInterviewToCalendar } from "@/lib/google/availability";
import { GoogleError } from "@/lib/google/errors";
import { prisma } from "@/lib/prisma";

// The next interview's date and time (E9-9), set beside the status on an
// application's page or from Claude through the connector (jobauto fork).
// It shows on the dashboard's "Worth a look" while the application is in
// Interview, and while Dossier keeps interviews in Google Calendar, the
// event is added, moved or deleted to match.

const GONE = "That application no longer exists.";

/** Saves the next interview, or removes it with null. */
export async function saveInterviewDate(applicationId: string, at: Date | null): Promise<void> {
  const { count } = await prisma.application.updateMany({ where: { id: applicationId }, data: { nextInterviewAt: at } });
  if (count === 0) throw new ActionError(GONE);
}

/**
 * After saveInterviewDate: brings Google Calendar in step while Dossier keeps
 * interviews there, and says how it went, for the toast or Claude. When
 * Google can't be reached, the date stays saved and the answer says so.
 */
export async function followInCalendar(applicationId: string, at: Date | null): Promise<string> {
  try {
    const { inCalendar } = await syncInterviewToCalendar(applicationId);
    if (inCalendar) return at ? "Interview date saved, in your calendar too." : "Interview date removed, from your calendar too.";
    return at ? "Interview date saved. It'll show on your dashboard." : "Interview date removed.";
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error;
    return `${at ? "Interview date saved" : "Interview date removed"}, but your calendar wasn't changed: ${error.message}`;
  }
}

const moment = z.iso.datetime({ offset: true, local: true });

/** The offset of `timeZone` from UTC at a moment, in milliseconds. */
function offsetAt(time: number, timeZone: string): number {
  const [, sign, hours, minutes] = /([+-])(\d{2}):(\d{2})$/.exec(isoInZone(new Date(time), timeZone)) ?? ["", "+", "0", "0"];
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}

/**
 * An interview's date and time as Claude gives it: with its offset, as in
 * "2026-11-04T14:00:00+01:00", or as on a clock, "2026-11-04T14:00", which
 * is read in `timeZone`, as the page reads it in the browser's. Null when
 * it isn't a date and time.
 */
export function interviewMoment(value: string, timeZone: string): Date | null {
  if (!moment.safeParse(value).success) return null;
  if (/(?:z|[+-]\d{2}:\d{2})$/i.test(value)) return new Date(value);
  const clock = Date.parse(`${value}Z`);
  // Twice, for a time close to the switch to or from summer time.
  return new Date(clock - offsetAt(clock - offsetAt(clock, timeZone), timeZone));
}
