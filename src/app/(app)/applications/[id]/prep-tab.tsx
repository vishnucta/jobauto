"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useJob } from "@/hooks/use-job";
import { FALLBACK, SAY_AGAIN, spokenMatch, type CallPrep, type Pair } from "@/lib/call-prep";

import { prepareForCall } from "./prep-actions";

export type PrepTabData = {
  /** The pack, once prepared. */
  pack: CallPrep | null;
  /** The job preparing it, e.g. since before a reload. */
  jobId: string | null;
};

/** Only the pack prints: everything else on the page is hidden on paper. */
const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  [data-prep-print], [data-prep-print] * { visibility: visible !important; }
  [data-prep-print] { position: absolute; inset: 0 auto auto 0; width: 100%; padding: 0; }
  [data-prep-screen] { display: none !important; }
}`;

/**
 * Call prep (Phase 3, jobauto fork): what to say on the first phone call, in
 * German she can say with the English beside it, ready to print and keep by
 * the phone, and a practice mode that reads each question aloud and listens
 * to her answer.
 */
export function PrepTab({ applicationId, data, aiReady, company }: { applicationId: string; data: PrepTabData; aiReady: boolean; company: string }) {
  const router = useRouter();
  const [jobId, setJobId] = useState(data.jobId);
  const [practising, setPractising] = useState(false);
  const job = useJob<CallPrep>(jobId, 0, (view) => {
    if (view.status === "DONE") {
      setJobId(null);
      router.refresh();
    } else if (view.status === "FAILED") {
      setJobId(null);
      toast(view.error ?? "The prep pack couldn't be prepared. Try again.");
    }
  });
  const pack = data.pack;

  const prepare = async () => {
    const result = toastResult(await prepareForCall({ id: applicationId }));
    if (result.ok) setJobId(result.data.jobId);
  };

  const prepareButton = (label: string) =>
    aiReady ? (
      <Button variant={pack ? "secondary" : "primary"} size="sm" aria-disabled={jobId !== null || undefined} onClick={jobId ? undefined : () => void prepare()}>
        {jobId ? (job?.step ?? "Preparing…") : label}
      </Button>
    ) : null;

  if (!pack) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-10 pt-8 pb-[var(--composer-space,2rem)]">
        <div className="flex max-w-[640px] flex-col gap-3 rounded-panel border border-line-card bg-card p-7">
          <h2 className="font-serif text-section">Prepare for the call</h2>
          <p className="text-sm text-pretty text-muted">
            A first call in Germany often starts in German. This prepares the questions it usually asks, with answers from your profile in short German you can say, the English beside
            them, a line for salary, three stories from your roles, and questions to ask them. Print it to keep by the phone, and practise it out loud. It&apos;s prepared on its own
            when the application moves to Screening or Interview.
          </p>
          {aiReady ? prepareButton("Prepare for the call") : <p className="text-meta text-warning">Set up an AI provider in Settings → AI provider first.</p>}
          <SayItCard pair={FALLBACK} title="When German runs out" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-10 pt-8 pb-[var(--composer-space,2rem)]">
      <style>{PRINT_CSS}</style>
      <div data-prep-screen className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-pressed={practising} onClick={() => setPractising(!practising)}>
          {practising ? "Back to the pack" : "Practise out loud"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          Print
        </Button>
        {prepareButton("Prepare again")}
      </div>

      {practising ? (
        <Practice questions={[...pack.questions, { question: { de: "Und wenn Ihr Deutsch nicht reicht?", en: "And if your German isn't enough?" }, answer: FALLBACK }]} />
      ) : (
        <article data-prep-print aria-label="Call prep" className="flex max-w-[860px] flex-col gap-6">
          <h2 className="font-serif text-section">First call{company ? ` with ${company}` : ""}</h2>

          {pack.gaps.length > 0 && (
            <section aria-label="Decide before the call" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
              <p className="font-medium">Decide before the call, and fill in each […]:</p>
              <ul className="list-disc pl-5">
                {pack.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </section>
          )}
          {pack.unverified.length > 0 && (
            <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
              Check these against your profile before you say them: {pack.unverified.join(", ")}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <SayItCard pair={FALLBACK} title="When German runs out" />
            <SayItCard pair={SAY_AGAIN} title="When it was too fast" />
          </div>

          <section aria-labelledby="prep-questions" className="flex flex-col gap-3">
            <h3 id="prep-questions" className="text-[15px] font-medium">
              What they&apos;ll likely ask
            </h3>
            <ol className="flex flex-col gap-3">
              {pack.questions.map((entry) => (
                <li key={entry.question.de} className="break-inside-avoid rounded-card border border-line-card bg-card p-4">
                  <p className="font-medium">{entry.question.de}</p>
                  <p className="text-meta text-muted">{entry.question.en}</p>
                  <p className="mt-2 text-[17px] leading-relaxed">{entry.answer.de}</p>
                  <p className="text-meta text-muted">{entry.answer.en}</p>
                </li>
              ))}
            </ol>
          </section>

          <SayItCard pair={pack.salary} title="Salary" />

          {pack.stories.length > 0 && (
            <section aria-labelledby="prep-stories" className="flex flex-col gap-3">
              <h3 id="prep-stories" className="text-[15px] font-medium">
                Stories for &ldquo;Tell me about a time…&rdquo;
              </h3>
              {pack.stories.map((story) => (
                <div key={story.title} className="break-inside-avoid rounded-card border border-line-card bg-card p-4 text-sm">
                  <p className="font-medium">{story.title}</p>
                  <p>
                    <span className="text-muted">Situation: </span>
                    {story.situation}
                  </p>
                  <p>
                    <span className="text-muted">What I did: </span>
                    {story.action}
                  </p>
                  <p>
                    <span className="text-muted">Result: </span>
                    {story.result}
                  </p>
                </div>
              ))}
            </section>
          )}

          {pack.toAsk.length > 0 && (
            <section aria-labelledby="prep-ask" className="flex flex-col gap-2">
              <h3 id="prep-ask" className="text-[15px] font-medium">
                Questions to ask them
              </h3>
              <ul className="flex flex-col gap-2">
                {pack.toAsk.map((entry) => (
                  <li key={entry.de}>
                    <p>{entry.de}</p>
                    <p className="text-meta text-muted">{entry.en}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      )}
    </div>
  );
}

function SayItCard({ pair, title }: { pair: Pair; title: string }) {
  return (
    <section aria-label={title} className="break-inside-avoid rounded-card bg-track px-4 py-3">
      <p className="text-label text-muted">{title}</p>
      <p className="text-[17px] leading-relaxed">{pair.de}</p>
      <p className="text-meta text-muted">{pair.en}</p>
    </section>
  );
}

// ─── Practice ────────────────────────────────────────────────────────────────

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

/** The browser's speech recognition (Chrome, Edge, Safari), or null where there's none (Firefox). */
function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const found = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition });
  return found.SpeechRecognition ?? found.webkitSpeechRecognition ?? null;
}

/** Reads German aloud with the browser's own voice; nothing leaves the device but what the browser does. */
function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "de-DE";
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

/**
 * One question at a time: hear it, answer out loud, and see how much of the
 * written answer she said. Not a grade, a repetition machine.
 */
function Practice({ questions }: { questions: CallPrep["questions"] }) {
  const [index, setIndex] = useState(0);
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  const [shown, setShown] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  // Only ever shown after a click, so it's never rendered on the server.
  const [canListen] = useState(() => recognitionClass() !== null);
  const entry = questions[index];

  useEffect(() => () => recognition.current?.stop(), []);

  const go = (next: number) => {
    recognition.current?.stop();
    setIndex(next);
    setHeard("");
    setShown(false);
  };

  const listen = () => {
    const Class = recognitionClass();
    if (!Class) return;
    if (listening) return void recognition.current?.stop();
    const current = new Class();
    current.lang = "de-DE";
    current.interimResults = true;
    current.continuous = true;
    current.onresult = (event) => setHeard(Array.from(event.results, (result) => result[0]?.transcript ?? "").join(" "));
    current.onend = () => setListening(false);
    current.onerror = (event) => {
      setListening(false);
      if (event.error === "not-allowed") toast("Allow the microphone for this page to practise out loud.");
    };
    recognition.current = current;
    setHeard("");
    setListening(true);
    current.start();
  };

  const match = heard ? spokenMatch(entry.answer.de, heard) : null;

  return (
    <section aria-label="Practice" className="flex max-w-[720px] flex-col gap-4 rounded-panel border border-line-card bg-card p-7">
      <p className="text-meta text-muted">
        Question {index + 1} of {questions.length}
      </p>
      <p className="font-serif text-section">{entry.question.de}</p>
      <p className="text-meta text-muted">{entry.question.en}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => speak(entry.question.de)}>
          Hear the question
        </Button>
        {canListen ? (
          <Button size="sm" aria-pressed={listening} onClick={listen}>
            {listening ? "Stop" : "Answer out loud"}
          </Button>
        ) : (
          <p className="text-meta text-muted">This browser can&apos;t listen. Say your answer aloud, then compare it with yours below.</p>
        )}
        <Button variant="secondary" size="sm" aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? "Hide my answer" : "Show my answer"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => speak(entry.answer.de)}>
          Hear my answer
        </Button>
      </div>
      {heard && (
        <div role="status" className="rounded-card bg-track px-4 py-3 text-sm">
          <p className="text-label text-muted">You said</p>
          <p>{heard}</p>
          {match !== null && !listening && <p className="mt-1 text-meta text-muted">{match}% of your written answer. {match >= 70 ? "Well done." : "Try it once more."}</p>}
        </div>
      )}
      {shown && (
        <div className="rounded-card border border-line-card px-4 py-3">
          <p className="text-[17px] leading-relaxed">{entry.answer.de}</p>
          <p className="text-meta text-muted">{entry.answer.en}</p>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" aria-disabled={index === 0 || undefined} onClick={index === 0 ? undefined : () => go(index - 1)}>
          ← Previous
        </Button>
        <Button variant="secondary" size="sm" onClick={() => go((index + 1) % questions.length)}>
          {index + 1 === questions.length ? "Start again" : "Next →"}
        </Button>
      </div>
    </section>
  );
}
