"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { FIELD_NEW_DAYS, FIELD_SCORE_CHOICES } from "@/lib/field-match";

import { updateSettings } from "./actions";

/**
 * Settings → Scoring, while a profile is in her field (jobauto fork,
 * field-scoring.ts): how many new postings in her field are scored on their
 * own each day, 0 for none. It says what counts, what is never scored, that
 * each one goes to the scoring model, and how the number relates to the job
 * agent's own limit, so the two never add up unseen.
 */
export function FieldScoringCard({ perDay: initial, agent }: { perDay: number; agent: { on: boolean; maxScores: number } }) {
  const track = useTrackSave();
  const [perDay, setPerDay] = useState(initial);

  const change = async (next: number) => {
    const before = perDay;
    setPerDay(next);
    if (!toastResult(await track(updateSettings({ fieldScoresPerDay: next }))).ok) setPerDay(before);
  };

  return (
    <section aria-labelledby="field-scoring-heading" className="flex flex-col gap-3">
      <h2 id="field-scoring-heading" className="text-[15px] font-medium">
        Postings in your field
      </h2>
      <Card className="flex flex-col gap-4">
        <p className="text-sm text-pretty text-muted">
          Dossier scores a few new postings in your field each day without you pressing Score, the newest first, so the ones that matter most show how well they
          fit. Each one sends the posting and your profile to the scoring model above.
        </p>
        <Select label="Score on their own, each day" value={String(perDay)} onChange={(event) => void change(Number(event.target.value))} className="max-w-[260px]">
          {[...new Set([...FIELD_SCORE_CHOICES, perDay])]
            .sort((a, b) => a - b)
            .map((choice) => (
              <option key={choice} value={choice}>
                {choice === 0 ? "0 (off)" : `Up to ${choice}`}
              </option>
            ))}
        </Select>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-meta text-pretty text-muted">
          <li>
            Counted are postings Positions found in the last {FIELD_NEW_DAYS} days whose title names one of your field&apos;s words, or whose text names two. No
            job portal is asked for anything.
          </li>
          <li>A posting is never scored twice. One that needs far more German than your profile has, or that you dismissed or applied to, is left out.</li>
          <li>Nothing is scored while scoring is off: without a scoring model, or before your profile&apos;s levels are chosen.</li>
          <li>
            {agent.on
              ? perDay > 0
                ? `The job agent scores up to ${agent.maxScores} postings a run from its own searches as well. With both on, at most ${agent.maxScores + perDay} postings a day are scored without you asking; a posting one of them scored is not scored again by the other.`
                : `The job agent still scores up to ${agent.maxScores} postings a run from its own searches.`
              : perDay > 0
                ? `The job agent is off, so these ${perDay} are all that is scored without you asking.`
                : "The job agent is off too, so nothing is scored without you asking."}
          </li>
        </ul>
      </Card>
    </section>
  );
}
