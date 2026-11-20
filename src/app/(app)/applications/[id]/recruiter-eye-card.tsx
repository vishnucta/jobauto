import type { Doubt } from "@/lib/recruiter-eye";

/**
 * "Through a German recruiter's eyes" on the Job posting tab (jobauto fork):
 * the doubts a recruiter has about a foreign candidate in the first thirty
 * seconds, whether her resume and letter already answer each, and what
 * would. A doubt left open is often the silent reason for a rejection.
 */
export function RecruiterEyeCard({ doubts, onOpenAnswers }: { doubts: readonly Doubt[]; onOpenAnswers: () => void }) {
  if (doubts.length === 0) return null;
  const open = doubts.filter((doubt) => !doubt.answered);
  return (
    <section aria-labelledby="recruiter-eye" className="flex w-full max-w-[640px] flex-col gap-4 rounded-panel border border-line-card bg-card px-[30px] py-7">
      <div className="flex flex-col gap-1.5">
        <h2 id="recruiter-eye" className="font-serif text-section">
          Through a German recruiter&apos;s eyes
        </h2>
        <p className="text-sm text-pretty text-muted">
          {open.length === 0
            ? "What a recruiter usually wonders about a candidate from abroad, your resume and letter already answer."
            : `What a recruiter usually wonders about a candidate from abroad, and rarely asks. ${open.length === 1 ? "One is" : `${open.length} are`} still open in your resume and letter.`}
        </p>
      </div>
      <ul className="flex flex-col">
        {doubts.map((doubt) => (
          <li key={doubt.id} className="flex gap-3 border-t border-line py-3 first:border-t-0">
            <span aria-hidden className={doubt.answered ? "text-success" : "text-warning"}>
              {doubt.answered ? "✓" : "!"}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="text-sm">
                <span className="sr-only">{doubt.answered ? "Answered: " : "Open: "}</span>
                {doubt.question}
              </p>
              {!doubt.answered && <p className="text-meta text-pretty text-muted">{doubt.fix}</p>}
            </div>
          </li>
        ))}
      </ul>
      {open.length > 0 && (
        <p className="text-meta text-muted">
          New letters answer what your standard answers hold.{" "}
          <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={onOpenAnswers}>
            Open your standard answers
          </button>
          , then regenerate the letter&apos;s closing paragraph for this one.
        </p>
      )}
    </section>
  );
}
