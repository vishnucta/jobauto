import { addDays, dayOf, type Day } from "@/lib/calendar-view";

// The weekly target (jobauto fork): how many applications to send each week,
// Monday to Sunday in the user's time zone, how this week is going, and how
// many weeks in a row met it. A steady number of good applications a week
// is what a search runs on; the streak makes the grind visible.

export const WEEKLY_TARGETS = [0, 3, 5, 8, 10, 12, 15, 20] as const;

export type WeekCount = { start: Day; sent: number; met: boolean };

export type WeeklyProgress = {
  target: number;
  /** Sent this week so far. */
  sent: number;
  /** Days left in this week, today included: 7 on a Monday, 1 on a Sunday. */
  daysLeft: number;
  /** Weeks in a row that met the target, up to last week, and this one too once it's met. */
  streak: number;
  /** The last eight weeks, oldest first, this one last. */
  weeks: WeekCount[];
};

/** The Monday of `day`'s week. */
export function weekStart(day: Day): Day {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
}

const WEEKS_SHOWN = 8;
/** How far back a streak is counted. */
const STREAK_WEEKS = 104;

export function weeklyProgress(sentAt: readonly Date[], target: number, now: Date, timeZone: string): WeeklyProgress {
  const today = dayOf(now, timeZone);
  const thisWeek = weekStart(today);
  const byWeek = new Map<Day, number>();
  for (const moment of sentAt) {
    const start = weekStart(dayOf(moment, timeZone));
    byWeek.set(start, (byWeek.get(start) ?? 0) + 1);
  }
  const count = (start: Day) => byWeek.get(start) ?? 0;
  const met = (start: Day) => target > 0 && count(start) >= target;

  let streak = 0;
  for (let back = 1; back <= STREAK_WEEKS && met(addDays(thisWeek, -7 * back)); back++) streak += 1;
  if (met(thisWeek)) streak += 1;

  const weeks = Array.from({ length: WEEKS_SHOWN }, (_, index) => {
    const start = addDays(thisWeek, -7 * (WEEKS_SHOWN - 1 - index));
    return { start, sent: count(start), met: met(start) };
  });
  const [year, month, date] = today.split("-").map(Number);
  const daysLeft = 7 - ((new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7);
  return { target, sent: count(thisWeek), daysLeft, streak, weeks };
}

/** "3 to go, 4 days left", "Done for this week", or nothing without a target. */
export function weekStatus({ target, sent, daysLeft }: Pick<WeeklyProgress, "target" | "sent" | "daysLeft">): string {
  if (target === 0) return "";
  if (sent >= target) return sent > target ? `Done for this week, ${sent - target} over` : "Done for this week";
  const left = target - sent;
  return `${left} to go, ${daysLeft === 1 ? "today left" : `${daysLeft} days left`}`;
}
