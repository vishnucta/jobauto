import { cn } from "@/lib/cn";
import type { GermanFit } from "@/lib/german-need";

const TONES = {
  fits: "bg-track text-ink",
  stretch: "bg-warning-surface text-warning",
  out: "bg-danger-surface text-danger",
} as const;

/** "German C1", "Ad in German" or "English team" on a posting's card, with why in its title. */
export function GermanBadge({ fit }: { fit: GermanFit | undefined }) {
  if (!fit?.label) return null;
  return (
    <span title={fit.explanation} className={cn("rounded-full px-2 py-0.5 text-xs whitespace-nowrap", TONES[fit.verdict])}>
      {fit.label}
    </span>
  );
}

/** The German a posting asks for, quoted, in its detail. */
export function GermanNote({ fit }: { fit: GermanFit }) {
  if (!fit.explanation) return null;
  return (
    <p role="note" className={cn("rounded-card px-4 py-3 text-meta", fit.verdict === "fits" ? "bg-track" : fit.verdict === "stretch" ? "bg-warning-surface text-warning" : "bg-danger-surface text-danger")}>
      {fit.explanation}
    </p>
  );
}
