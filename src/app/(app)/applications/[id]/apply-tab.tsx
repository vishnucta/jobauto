"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ProgressSteps } from "@/components/ui/progress-steps";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import type { ApplyAttemptStatus } from "@/generated/prisma/enums";
import { LANGUAGE_LEVEL_ANSWERS, type ApplyAnswers } from "@/lib/apply/answers";
import { APPLY_STEPS } from "@/lib/apply/steps";
import { OPEN_ATTEMPT_STATUSES, type ApplyAttemptView, type ApplyTabData } from "@/lib/apply/view";
import { cn } from "@/lib/cn";
import type { ApplyJobResult } from "@/lib/jobs/apply";
import type { JobView } from "@/lib/jobs/runner";

import { saveApplyAnswers, settleApplyAttempt, startApply } from "./apply-actions";
import { JobWatcher } from "./job-watcher";

/** How often the tab asks the server whether the browser saw the confirmation, while it's watching. */
const REFRESH_MS = 4_000;

const STATUS_LABELS: Record<ApplyAttemptStatus, string> = {
  OPENING: "Working on it",
  WAITING: "Waiting for you",
  SUBMITTED: "Sent",
  ABANDONED: "Not sent",
  FAILED: "Didn't work",
};

/**
 * The Apply tab (Phase A of the bewerbung fork): applies on the employer's
 * own page. A visible Chrome window opens, the form is filled from the
 * profile and the standard answers, the PDFs are attached, and the user
 * checks and presses Send; the tab shows what was filled, what's left to
 * her, and how each run ended. When the posting asks for an email instead,
 * it points to the Email tab.
 */
export function ApplyTab({ applicationId, data, onGoToEmail }: { applicationId: string; data: ApplyTabData; onGoToEmail: () => void }) {
  const router = useRouter();
  // The job to follow: one started here, else the one the server reports (e.g. since before a reload), unless it's the one just seen finish.
  const [started, setStarted] = useState<{ id: string; revision: number } | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const job = started ?? (data.running && data.running !== finished ? { id: data.running, revision: 0 } : null);
  const [step, setStep] = useState<string | null>(null);
  const [starting, startStarting] = useTransition();
  const [settling, startSettling] = useTransition();

  const latest = data.attempts[0] ?? null;
  const watching = Boolean(latest && latest.watching && OPEN_ATTEMPT_STATUSES.includes(latest.status));
  // While the browser waits for her, ask now and then whether it saw the confirmation.
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [watching, router]);

  const jobChanged = (view: JobView<ApplyJobResult>) => {
    setStep(view.step);
    if (view.status !== "DONE" && view.status !== "FAILED") return;
    setFinished(view.id);
    setStarted(null);
    setStep(null);
    if (view.status === "FAILED" && view.error) toast(view.error);
    router.refresh();
  };

  const start = () =>
    startStarting(async () => {
      const result = await startApply({ id: applicationId });
      if (!result.ok) return toast(result.error);
      setStarted({ id: result.data.jobId, revision: 0 });
      router.refresh();
    });

  const settle = (attemptId: string, sent: boolean) =>
    startSettling(async () => {
      const result = await settleApplyAttempt({ attemptId, sent });
      if (!result.ok) return toast(result.error);
      if (result.toast) toast(result.toast);
      router.refresh();
    });

  const current = step ? Math.max(0, (APPLY_STEPS as readonly string[]).indexOf(step)) : 0;
  const { plan } = data;
  const busy = job !== null || starting;

  return (
    <div className="flex flex-1 flex-col items-center gap-4 overflow-auto bg-canvas px-10 pt-11 pb-16">
      {job && <JobWatcher<ApplyJobResult> key={job.id} id={job.id} revision={job.revision} onChange={jobChanged} />}

      <Panel title="Apply on the employer's page">
        {plan.kind === "web" && (
          <>
            <p className="text-sm text-pretty text-muted">
              The form for this posting is on <strong className="font-medium text-ink">{plan.host}</strong>
              {plan.atsLabel !== "the employer's website" && <> ({plan.atsLabel})</>}.{" "}
              {plan.account
                ? "That site asks you to sign in. The browser window keeps you signed in from one application to the next, so you only do it once."
                : "I open it in a Chrome window on this computer, fill in what I know, attach your PDFs, and leave the checking and the Send button to you."}
              {plan.board && " It's a job board: its apply button may lead on to the employer's own page, and I'll follow it."}
            </p>
            {data.missing.length > 0 && (
              <p className="rounded-control bg-warning-surface px-3 py-2 text-sm text-warning">
                Your profile has no {joinWords(data.missing)}. Forms nearly always ask for it:{" "}
                <Link href="/profile" className="underline underline-offset-2">
                  add it to your profile
                </Link>{" "}
                first.
              </p>
            )}
            {!data.hasResume && <p className="text-sm text-muted">This application has no resume to attach yet.</p>}
            {job ? (
              <ProgressSteps steps={APPLY_STEPS} current={current} className="mt-1" />
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Button aria-disabled={busy || !data.hasResume || undefined} onClick={() => !busy && data.hasResume && start()}>
                  {starting ? "Starting…" : latest ? "Open and fill it in again" : "Open and fill it in"}
                </Button>
                <span className="text-meta text-muted">
                  {data.answers.autoSubmit && plan.autoSubmitOk ? "Send is pressed for you on this site when nothing is left to fill." : "You press Send yourself."}
                </span>
              </div>
            )}
          </>
        )}
        {plan.kind === "email" && (
          <>
            <p className="text-sm text-pretty text-muted">
              This posting asks for applications by email, at <strong className="font-medium text-ink">{plan.to}</strong>. The Email tab writes the email and
              sends it with your PDFs attached, so there&apos;s no form to fill here.
            </p>
            <Button variant="secondary" className="mt-1 self-start" onClick={onGoToEmail}>
              Go to the Email tab
            </Button>
          </>
        )}
        {plan.kind === "none" && (
          <p className="text-sm text-pretty text-muted">
            No link to apply at was saved with this application, and the posting names no email address. Apply by hand with the PDFs from the
            Resume and Cover letter tabs, then mark it as sent.
          </p>
        )}
      </Panel>

      {latest && !job && <AttemptPanel attempt={latest} settling={settling} onSettle={settle} onRetry={plan.kind === "web" ? start : undefined} />}

      <AnswersPanel applicationId={applicationId} answers={data.answers} autoSubmitOk={plan.kind === "web" && plan.autoSubmitOk} />

      {data.attempts.length > 1 && (
        <Panel title="Earlier runs">
          <ul className="flex flex-col divide-y divide-line">
            {data.attempts.slice(1).map((attempt) => (
              <li key={attempt.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                <span className="text-ink">
                  {STATUS_LABELS[attempt.status]} <span className="text-muted">· {attempt.host}</span>
                </span>
                <span className="text-meta text-muted">{attempt.startedAt}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/** How the latest run went, and what the user can do about it. */
function AttemptPanel({
  attempt,
  settling,
  onSettle,
  onRetry,
}: {
  attempt: ApplyAttemptView;
  settling: boolean;
  onSettle: (attemptId: string, sent: boolean) => void;
  onRetry?: () => void;
}) {
  const open = OPEN_ATTEMPT_STATUSES.includes(attempt.status);
  const required = attempt.unfilled.filter((entry) => entry.required);
  const optional = attempt.unfilled.filter((entry) => !entry.required);
  const aiWrote = attempt.filled.filter((entry) => entry.byAi);
  return (
    <Panel
      title={
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span>{STATUS_LABELS[attempt.status]}</span>
          <span className="text-meta font-sans text-muted">
            {attempt.startedAt} · {attempt.host}
          </span>
        </span>
      }
      tone={attempt.status === "SUBMITTED" ? "success" : open ? "warning" : attempt.status === "FAILED" ? "danger" : "plain"}
    >
      <p className="text-sm text-pretty">{attempt.note}</p>
      {open && !attempt.watching && (
        <p className="text-sm text-muted">The server isn&apos;t watching the browser window any more (it was restarted). Say below how it ended.</p>
      )}

      {aiWrote.length > 0 && (
        <p className="rounded-control bg-warning-surface px-3 py-2 text-sm text-warning">
          The AI wrote {aiWrote.length === 1 ? "an answer" : `${aiWrote.length} answers`} to the form&apos;s own questions ({joinWords(aiWrote.map((entry) => entry.label))}).
          Read {aiWrote.length === 1 ? "it" : "them"} in the browser window before you send: you must be able to stand behind every word.
        </p>
      )}

      {required.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-meta text-muted">Fill these in yourself before sending</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {required.map((entry, index) => (
              <li key={index}>
                <span className="text-ink">{entry.label}</span> <span className="text-muted">· {entry.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Button aria-disabled={settling || undefined} onClick={() => !settling && onSettle(attempt.id, true)}>
            I sent it
          </Button>
          <Button variant="text" aria-disabled={settling || undefined} onClick={() => !settling && onSettle(attempt.id, false)}>
            I didn&apos;t send it
          </Button>
        </div>
      )}
      {!open && attempt.status !== "SUBMITTED" && onRetry && (
        <div className="mt-1">
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}

      {(attempt.filled.length > 0 || optional.length > 0) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">
            What I filled in ({attempt.filled.length}){optional.length > 0 && <>, and {optional.length} optional {optional.length === 1 ? "field" : "fields"} I left</>}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {attempt.filled.map((entry, index) => (
              <li key={index} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{entry.label}</span>
                <span className="text-muted">
                  · {entry.what}
                  {entry.value && <> · {entry.value.length > 80 ? `${entry.value.slice(0, 80)}…` : entry.value}</>}
                </span>
              </li>
            ))}
            {optional.map((entry, index) => (
              <li key={`left-${index}`} className="flex flex-wrap gap-x-2">
                <span className="text-ink">{entry.label}</span>
                <span className="text-muted">· left to you · {entry.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {(attempt.screenshot || attempt.confirmation) && (
        <p className="flex flex-wrap gap-4 text-meta">
          {attempt.screenshot && (
            <a href={`/api/apply/${attempt.id}/filled`} target="_blank" rel="noreferrer" className="text-muted underline underline-offset-2 hover:text-ink">
              Screenshot of the filled form
            </a>
          )}
          {attempt.confirmation && (
            <a href={`/api/apply/${attempt.id}/confirmation`} target="_blank" rel="noreferrer" className="text-muted underline underline-offset-2 hover:text-ink">
              Screenshot of the confirmation
            </a>
          )}
        </p>
      )}
    </Panel>
  );
}

/** The standard answers every form asks for, saved once. */
function AnswersPanel({ applicationId, answers: saved, autoSubmitOk }: { applicationId: string; answers: ApplyAnswers; autoSubmitOk: boolean }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<ApplyAnswers>(saved);
  const [saving, startSaving] = useTransition();
  const set = <K extends keyof ApplyAnswers>(key: K, value: ApplyAnswers[K]) => setAnswers((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(answers) !== JSON.stringify(saved);

  const save = () =>
    startSaving(async () => {
      const result = await saveApplyAnswers({ id: applicationId, answers });
      if (!result.ok) return toast(result.error);
      if (result.toast) toast(result.toast);
      router.refresh();
    });

  return (
    <Panel title="Your standard answers">
      <p className="text-sm text-pretty text-muted">
        What German forms ask for and your profile doesn&apos;t hold. Saved once, used on every form; leave one empty and I&apos;ll leave that field to you.
      </p>
      <div className="grid gap-4 @min-[560px]:grid-cols-2">
        <Input label="Salary expectation" placeholder="e.g. 55.000 € brutto/Jahr" value={answers.salary} onChange={(event) => set("salary", event.target.value)} />
        <Input label="Earliest start date" hint="“sofort”, or a day as YYYY-MM-DD" placeholder="sofort" value={answers.startDate} onChange={(event) => set("startDate", event.target.value)} />
        <Input label="Notice period" placeholder="e.g. keine, or 3 Monate" value={answers.noticePeriod} onChange={(event) => set("noticePeriod", event.target.value)} />
        <Input label="Street and number" hint="When the address line of your profile doesn't split cleanly" value={answers.street} onChange={(event) => set("street", event.target.value)} />
        <Input label="Postal code" value={answers.postalCode} onChange={(event) => set("postalCode", event.target.value)} />
        <Select label="German level" value={answers.germanLevel} onChange={(event) => set("germanLevel", event.target.value as ApplyAnswers["germanLevel"])}>
          {LANGUAGE_LEVEL_ANSWERS.map((level) => (
            <option key={level} value={level}>
              {level === "native" ? "Native" : level}
            </option>
          ))}
        </Select>
        <Select label="English level" value={answers.englishLevel} onChange={(event) => set("englishLevel", event.target.value as ApplyAnswers["englishLevel"])}>
          {LANGUAGE_LEVEL_ANSWERS.map((level) => (
            <option key={level} value={level}>
              {level === "native" ? "Native" : level}
            </option>
          ))}
        </Select>
        <Checkbox
          className="self-end"
          label="I'm allowed to work in Germany without sponsorship"
          checked={answers.workPermit}
          onChange={(event) => set("workPermit", event.target.checked)}
        />
      </div>
      <Toggle
        label="Press Send for me"
        description={
          autoSubmitOk
            ? "Only on systems whose forms are simple and stable (Personio, Greenhouse, Lever, JOIN and a few more), only when nothing is left for you to fill, and never past a CAPTCHA. Everywhere else you press Send yourself."
            : "On systems whose forms are simple and stable (Personio, Greenhouse, Lever, JOIN and a few more), when nothing is left for you to fill and there's no CAPTCHA. This posting's site isn't one of them, so here you press Send yourself either way."
        }
        checked={answers.autoSubmit}
        onCheckedChange={(checked) => set("autoSubmit", checked)}
      />
      <div className="flex items-center gap-3">
        <Button variant={dirty ? "primary" : "secondary"} aria-disabled={saving || !dirty || undefined} onClick={() => !saving && dirty && save()}>
          {saving ? "Saving…" : "Save answers"}
        </Button>
        {dirty && <span className="text-meta text-muted">Not saved yet</span>}
      </div>
    </Panel>
  );
}

function Panel({ title, tone = "plain", children }: { title: ReactNode; tone?: "plain" | "success" | "warning" | "danger"; children: ReactNode }) {
  return (
    <section
      className={cn(
        "@container flex w-full max-w-[680px] flex-col gap-3 rounded-panel border bg-card px-7 py-6",
        tone === "plain" && "border-line-card",
        tone === "success" && "border-success",
        tone === "warning" && "border-warning-line",
        tone === "danger" && "border-danger-line",
      )}
    >
      <h2 className="font-serif text-section">{title}</h2>
      {children}
    </section>
  );
}

/** "a, b and c" */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
