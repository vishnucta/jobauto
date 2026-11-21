"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { verdict, type ArmResult, type Experiment } from "@/lib/experiments";

import { startExperiment, stopExperiment } from "./actions";

const card = "flex flex-col rounded-panel border border-line-card bg-card";

/** Changes worth testing, to start from. */
const IDEAS: { name: string; a: string; b: string }[] = [
  { name: "Letter language", a: "English letter", b: "German letter" },
  { name: "Headline", a: "Financial Analyst", b: "Regulatory Reporting Specialist" },
  { name: "Letter opening", a: "Opens with the role", b: "Opens with a result I achieved" },
];

/**
 * Experiment (jobauto fork), on the dashboard: test one change at a time.
 * While it runs, each new application gets version A or B (its page says
 * which), and this card compares how often each moved on. Small numbers
 * only lean one way, and it says so.
 */
export function ExperimentCard({ running }: { running: { experiment: Experiment; results: ArmResult[] } | null }) {
  const router = useRouter();
  const [form, setForm] = useState<{ name: string; a: string; b: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || busy) return;
    setBusy(true);
    const result = toastResult(await startExperiment(form));
    setBusy(false);
    if (result.ok) {
      setForm(null);
      router.refresh();
    }
  };

  const stop = async () => {
    if (toastResult(await stopExperiment({})).ok) router.refresh();
  };

  return (
    <section aria-labelledby="experiment-heading" className={`${card} gap-4 px-7 py-[26px]`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="experiment-heading" className="text-[15px] font-medium">
          {running ? `Experiment: ${running.experiment.name}` : "Experiment"}
        </h2>
        {running && (
          <Button variant="text" size="sm" onClick={() => void stop()}>
            Stop it
          </Button>
        )}
      </div>

      {running ? (
        <>
          <table className="w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th>Version</th>
                <th>Sent</th>
                <th>Moved on</th>
              </tr>
            </thead>
            <tbody>
              {running.results.map((result) => (
                <tr key={result.arm} className="border-t border-line first:border-t-0">
                  <td className="py-1.5 pr-3">{result.label}</td>
                  <td className="py-1.5 pr-3 text-right text-muted tabular-nums">{result.sent} sent</td>
                  <td className="py-1.5 text-right font-medium tabular-nums">{result.replies} moved on</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-meta text-pretty text-muted">{verdict(running.results)} Each new application gets A or B, whichever has fewer; its page says which to write.</p>
        </>
      ) : form ? (
        <form onSubmit={(event) => void start(event)} aria-label="Start an experiment" className="flex flex-col gap-3">
          <Input label="What you're testing" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Version A" value={form.a} onChange={(event) => setForm({ ...form, a: event.target.value })} />
            <Input label="Version B" value={form.b} onChange={(event) => setForm({ ...form, b: event.target.value })} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" aria-disabled={busy || undefined}>
              Start
            </Button>
            <Button variant="text" size="sm" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-meta text-pretty text-muted">
            Test one change at a time, such as letters in English or in German. New applications alternate between the two versions, and this card shows which gets more
            answers.
          </p>
          <div className="flex flex-wrap gap-2">
            {IDEAS.map((idea) => (
              <Button key={idea.name} variant="secondary" size="sm" onClick={() => setForm(idea)}>
                {idea.name}
              </Button>
            ))}
            <Button variant="text" size="sm" onClick={() => setForm({ name: "", a: "", b: "" })}>
              Something else
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
