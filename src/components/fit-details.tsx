import { fitBand, type PostingFit } from "@/lib/fit";

import { ScoreBadge } from "./score-badge";

/** A posting's score (#208): its band, why it fits, and what gives pause. Find jobs and New application (public issue 66) show it. */
export function FitDetails({ fit }: { fit: PostingFit }) {
  return (
    <div className="flex items-start gap-3.5 rounded-card border border-line-card bg-paper px-4 py-3.5">
      <ScoreBadge score={fit.score} />
      <div className="flex min-w-0 flex-col gap-1.5 text-sm">
        <p className="font-medium">
          {fitBand(fit.score)} · {fit.score} of 100
        </p>
        {fit.reasons.length > 0 && (
          <ul aria-label="Why it fits" className="flex list-disc flex-col gap-0.5 pl-5 text-muted">
            {fit.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        )}
        {fit.redFlags.length > 0 && (
          <div className="text-meta text-warning">
            <p className="font-medium">Worth knowing</p>
            <ul className="flex list-disc flex-col gap-0.5 pl-5">
              {fit.redFlags.map((flag, index) => (
                <li key={index}>{flag}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
