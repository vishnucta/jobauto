"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { toastResult } from "@/components/toast";
import { controlBaseClassName } from "@/components/ui/field";
import { SelectControl } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { WEEKLY_TARGETS, weekStatus, type WeeklyProgress } from "@/lib/weekly-target";

import { rememberWeeklyTarget } from "./actions";

const card = "flex flex-col rounded-panel border border-line-card bg-card";
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * "This week" (jobauto fork): applications sent this week against the
 * weekly target, the last eight weeks, and the streak of weeks that met it.
 * The time filter doesn't scope it: a week is a week.
 */
export function WeeklyTarget({ progress }: { progress: WeeklyProgress }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [target, showTarget] = useOptimistic(progress.target);
  const { sent, streak, weeks } = progress;
  const tallest = Math.max(target, ...weeks.map((week) => week.sent), 1);
  const status = weekStatus({ ...progress, target });

  return (
    <section aria-labelledby="target-heading" className={`${card} gap-4 px-7 py-[26px]`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="target-heading" className="text-[15px] font-medium">
          This week
        </h2>
        {target > 0 && streak > 0 && <span className="text-meta text-muted">{plural(streak, "week", "weeks")} in a row</span>}
      </div>
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="font-serif text-[32px] leading-none tabular-nums">{sent}</span>
        <span className="text-control text-muted">{target > 0 ? `of ${target} sent${status ? ` · ${status}` : ""}` : sent === 1 ? "application sent" : "applications sent"}</span>
      </p>
      {target > 0 && (
        <div role="progressbar" aria-label="This week's target" aria-valuemin={0} aria-valuemax={target} aria-valuenow={Math.min(sent, target)} className="h-2 overflow-hidden rounded-full bg-track">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (sent / target) * 100)}%` }} />
        </div>
      )}
      {/* The sentence after it says the same in words. */}
      <div aria-hidden="true" className="flex h-12 items-end gap-1.5">
        {weeks.map((week, index) => (
          <span
            key={week.start}
            className={cn("flex-1 rounded-t-[3px]", week.met ? "bg-primary" : index === weeks.length - 1 ? "bg-line-strong" : "bg-track")}
            style={{ height: `${Math.max(4, (week.sent / tallest) * 100)}%` }}
          />
        ))}
      </div>
      <p className="sr-only">Sent in the last eight weeks, oldest first: {weeks.map((week) => week.sent).join(", ")}.</p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3.5 text-meta text-muted">
        <label htmlFor="weekly-target">Aim for</label>
        <SelectControl
          compact
          id="weekly-target"
          value={target}
          onChange={(event) => {
            const next = Number(event.target.value);
            startTransition(async () => {
              showTarget(next);
              if (toastResult(await rememberWeeklyTarget({ target: next })).ok) router.refresh();
            });
          }}
          className={cn(controlBaseClassName, "py-1 text-meta")}
        >
          {[...new Set([...WEEKLY_TARGETS, target])].sort((a, b) => a - b).map((choice) => (
            <option key={choice} value={choice}>
              {choice === 0 ? "no target" : `${choice} a week`}
            </option>
          ))}
        </SelectControl>
      </p>
    </section>
  );
}
