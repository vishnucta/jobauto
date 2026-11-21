import type { ReactNode } from "react";

import type { PostingFit } from "@/lib/fit";
import { coverageOf, fitWords, withoutPoints } from "@/lib/posting-coverage";
import { FACTORS } from "@/lib/scoring/factors";

import { PreviewReasons } from "./listing";
import { ScoreRing } from "./score-ring";

/** What a score from before the breakdown (1.15) says instead of its coverage (jobauto fork): it counted no requirements, so "none to check" would be false. */
export const NOT_SCORED_ANEW = "Not scored with the new method yet";

/**
 * How a posting fits one profile (#208, E25-6, E32-2): the requirements it
 * covers as a ring with words, then each part of the fit as a reason, ✓ in
 * its favour or – against, and what held it back. Never a number out of 100
 * (U1). A score without a breakdown, from before 1.15, says it's not scored
 * with the new method yet and shows its reasons as a plain list under
 * "Older score — score again": its reasons and red flags were never sorted
 * into for and against (jobauto fork).
 */
export function FitDetails({ fit, note }: { fit: PostingFit; /** Under the words: "Scored against Product design · Score again". */ note?: ReactNode }) {
  const coverage = coverageOf(fit);
  const { breakdown } = fit;
  if (!breakdown) {
    return (
      <div className="flex flex-col gap-3.5">
        <div className="flex items-center gap-3.5">
          <ScoreRing hit={0} total={0} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-[15px] font-medium text-ink">{NOT_SCORED_ANEW}</p>
            {note && <p className="text-meta text-muted">{note}</p>}
          </div>
        </div>
        <OlderReasons lines={[...fit.reasons, ...fit.redFlags]} />
      </div>
    );
  }
  const reasons = [
    ...breakdown.factors
      .filter((line) => line.max > 0 && line.reason.trim())
      .map((line) => ({ text: `${FACTORS.find((factor) => factor.id === line.factor)!.label}: ${line.reason}`, good: line.points >= line.max / 2 })),
    ...(breakdown.cap ? [{ text: breakdown.cap.reason, good: false }] : []),
  ];
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3.5">
        <ScoreRing hit={coverage.hit} total={coverage.total} size="lg" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[15px] font-medium text-ink">{fitWords(coverage)}</p>
          <p className="text-meta text-muted">
            {coverage.total > 0 ? `${coverage.hit} of ${coverage.total} requirements covered` : "The posting lists none to check"}
            {note && <> · {note}</>}
          </p>
        </div>
      </div>
      {reasons.length > 0 && <PreviewReasons reasons={reasons} />}
    </div>
  );
}

/**
 * An older score's reasons and red flags (jobauto fork), as a plain list
 * without ✓ or –: the model that wrote them mixed both, so "German is only
 * A2" could sit among its reasons. Shared with the Agent screen.
 */
export function OlderReasons({ lines }: { lines: readonly string[] }) {
  const shown = lines.map(withoutPoints).filter((line) => line.trim());
  return (
    <section aria-label="Older score" className="flex flex-col gap-2">
      <h3 className="text-meta font-medium text-muted">Older score — score again</h3>
      {shown.length > 0 && (
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[13.5px] text-ink marker:text-muted">
          {shown.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
