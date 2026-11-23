import { ApplicationStatus } from "@/generated/prisma/enums";
import type { NeedsYouItem } from "@/lib/dashboard";
import type { TodayItem } from "@/lib/today";

// Do today (jobauto fork): the dashboard's one list at the top, Needs you
// (E28-4) and Today's three (today.ts) together, each thing once. What's due
// this week comes first, as Needs you orders it; then offers and interviews
// with no date; then Today's three, her drafts as Needs you shows them and
// the job agent's drafts and matches after them; then her other drafts.

export type DoTodayRow =
  /** Something of hers that needs her, as a Needs you row. */
  | { kind: "needs"; item: NeedsYouItem }
  /** The job agent's draft to review, its match to prepare, or a posting in her field to prepare (Today's three). */
  | { kind: "agent"; item: Exclude<TodayItem, { kind: "finish" }> };

/** One list from both, never the same application twice. */
export function doToday(needsYou: readonly NeedsYouItem[], three: readonly TodayItem[]): DoTodayRow[] {
  const dated = needsYou.filter((item) => item.soon);
  const undated = needsYou.filter((item) => !item.soon);
  const shown = new Set(dated.map((item) => item.id));
  const rows: DoTodayRow[] = dated.map((item) => ({ kind: "needs", item }));
  const add = (item: NeedsYouItem) => {
    if (shown.has(item.id)) return;
    shown.add(item.id);
    rows.push({ kind: "needs", item });
  };

  for (const item of undated) if (item.status !== ApplicationStatus.DRAFT) add(item);
  for (const item of three) {
    if (item.kind === "finish") {
      // Her draft, as Needs you has it; one it doesn't list (archived, say) stays out.
      const own = undated.find((entry) => entry.id === item.applicationId);
      if (own) add(own);
    } else if (item.kind === "review") {
      if (!shown.has(item.applicationId)) {
        shown.add(item.applicationId);
        rows.push({ kind: "agent", item });
      }
    } else rows.push({ kind: "agent", item });
  }
  for (const item of undated) add(item);
  return rows;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The greeting's line under "Good morning": what's due this week, and the
 * drafts waiting that have no date (hers and the agent's), so it never says
 * "nothing needs you" above a list that has something in it.
 */
export function doTodaySummary(rows: readonly DoTodayRow[], { empty }: { empty: boolean }): string {
  const due = rows.filter((row) => row.kind === "needs" && row.item.soon).length;
  const drafts = rows.filter((row) => (row.kind === "needs" ? !row.item.soon && row.item.status === ApplicationStatus.DRAFT : row.item.kind === "review")).length;
  const waiting = drafts === 1 ? "1 draft is waiting" : `${drafts} drafts are waiting`;
  if (due > 0 && drafts > 0) return `${plural(due, "thing needs", "things need")} you this week, and ${waiting}.`;
  if (due > 0) return `${plural(due, "thing needs", "things need")} you this week.`;
  if (drafts > 0) return `${waiting} for you.`;
  // An offer or interview with no date, or a match to prepare: in the list, but not due.
  if (rows.length > 0) return "Nothing is due this week.";
  return empty ? "Your first application is only a paste away." : "Nothing needs you this week.";
}
