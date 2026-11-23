"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";

import { toast } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProgressSteps } from "@/components/ui/progress-steps";
import type { ApplyAttemptStatus } from "@/generated/prisma/enums";
import type { ApplyAnswers } from "@/lib/apply/answers";
import { hostOf } from "@/lib/apply/ats";
import { sendChannel } from "@/lib/apply/send-step";
import { APPLY_STEPS, FILL_STEPS } from "@/lib/apply/steps";
import { OPEN_ATTEMPT_STATUSES, type ApplyAttemptView, type ApplyTabData } from "@/lib/apply/view";
import { cn } from "@/lib/cn";
import type { ApplyJobResult } from "@/lib/jobs/apply";
import type { JobView } from "@/lib/jobs/runner";

import { APPLY_BROWSER_HREF } from "../../settings/apply-browser-card";
import { fillThisPage, savePostingLink, settleApplyAttempt, startApply } from "./apply-actions";
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
 * own page. A visible Chrome window opens, on the computer the app runs on
 * or on her laptop, the form is filled from the profile and the standard
 * answers, the PDFs are attached, and the user checks and presses Send; the
 * tab shows what was filled, what's left to her, and how each run ended.
 * One send path (send-step.ts, audit round 2): the assistant and its
 * warnings show only when the employer takes applications on a form; a job
 * board says to apply there by hand, with the assistant one click away; an
 * email posting points to the Email tab. Where the window opens is set in
 * Settings → Standard answers.
 */
export function ApplyTab({
  applicationId,
  data,
  onGoToEmail,
  gmailSends = false,
}: {
  applicationId: string;
  data: ApplyTabData;
  onGoToEmail: () => void;
  /** The Email tab can send with Gmail: without it, nothing promises it does. */
  gmailSends?: boolean;
}) {
  const router = useRouter();
  // The job to follow: one started here, else the one the server reports (e.g. since before a reload), unless it's the one just seen finish.
  const [started, setStarted] = useState<{ id: string; revision: number; kind: "run" | "page" } | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const job = started ?? (data.running && data.running !== finished ? { id: data.running, revision: 0, kind: data.runningKind ?? "run" } : null);
  // "Fill this page" works on the window of the run that is waiting; the run itself opens the employer's page.
  const filling = job?.kind === "page";
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
      setStarted({ id: result.data.jobId, revision: 0, kind: "run" });
      router.refresh();
    });

  const fill = () =>
    startStarting(async () => {
      const result = await fillThisPage({ id: applicationId });
      if (!result.ok) return toast(result.error);
      setStarted({ id: result.data.jobId, revision: 0, kind: "page" });
      router.refresh();
    });

  const settle = (attemptId: string, sent: boolean) =>
    startSettling(async () => {
      const result = await settleApplyAttempt({ attemptId, sent });
      if (!result.ok) return toast(result.error);
      if (result.toast) toast(result.toast);
      router.refresh();
    });

  const current = step ? Math.max(0, ((filling ? FILL_STEPS : APPLY_STEPS) as readonly string[]).indexOf(step)) : 0;
  const { plan } = data;
  const busy = job !== null || starting;
  // The assistant is offered for the employer's own form; on a job board only when she asks, or once it has run there.
  const channel = sendChannel(plan);
  const [tryAssistant, setTryAssistant] = useState(false);
  const assistant = channel === "form" || (channel === "board" && (tryAssistant || latest !== null || job !== null));
  // A site that isn't named like the employer may be a copy of the ad: the way to its own posting, on request (link-owner.ts).
  const [findOwn, setFindOwn] = useState(false);
  const unsure = plan.kind === "web" && plan.owner?.kind === "unsure" && data.findPosting ? data.findPosting : null;

  return (
    <div className="flex flex-1 flex-col items-center gap-4 overflow-auto bg-canvas px-10 pt-11 pb-[var(--composer-space,4rem)]">
      {job && <JobWatcher<ApplyJobResult> key={job.id} id={job.id} revision={job.revision} onChange={jobChanged} />}

      {/* A copy of the ad (jobauto fork, "Apply at the source"): no assistant, the way to the employer's own posting instead. */}
      {channel === "copy" && plan.kind === "web" && (
        <FindPostingPanel applicationId={applicationId} plan={plan} find={data.findPosting ?? null} />
      )}

      {/* One send path (send-step.ts, jobauto fork): the assistant only where the employer takes applications on a form. */}
      {channel === "board" && plan.kind === "web" && (
        <Panel title="Apply on the job board">
          <p className="text-sm text-pretty text-muted">
            The posting is on a job board, <strong className="font-medium text-ink">{plan.host}</strong>. Apply there by hand, and upload the Bewerbungsmappe: your
            letter, resume and Anlagen in one PDF. Then mark it as sent on the Email tab.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <a href={plan.url} target="_blank" rel="noopener noreferrer" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
              Open the posting<span aria-hidden>↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {!assistant && (
              <Button variant="text" onClick={() => setTryAssistant(true)}>
                Try the apply assistant anyway
              </Button>
            )}
          </div>
        </Panel>
      )}

      {assistant && plan.kind === "web" && (
        <>
          <Panel title="Before you use it" tone="warning">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-pretty">
              {plan.board && (
                <li>
                  Job boards such as StepStone, Indeed and LinkedIn may forbid automated tools in their terms, and their bot checks can stop it. If in doubt, apply
                  there by hand.
                </li>
              )}
              <li>Forms differ and change, so a field can be filled wrongly or missed. Check every field, and every answer the AI wrote, before you press Send.</li>
            </ul>
          </Panel>

          <Panel title="Apply on the employer's page">
            <p className="text-sm text-pretty text-muted">
              The form for this posting is on <strong className="font-medium text-ink">{plan.host}</strong>
              {plan.atsLabel !== "the employer's website" && <> ({plan.atsLabel})</>}.{" "}
              {plan.account
                ? "That site asks you to sign in. The browser window keeps you signed in from one application to the next, so you only do it once."
                : "I open it, fill in what I know, attach your PDFs, and leave the checking and the Send button to you."}
              {plan.board && " It's a job board: its apply button may lead on to the employer's own page, and I'll follow it."}
            </p>
            {/* Where the window opens is set up once, in Settings (audit round 2). */}
            <p className="text-meta text-pretty text-muted">
              {data.browserAddress
                ? `The window opens in the Chrome on your laptop, at ${data.browserAddress}.`
                : "The window opens on the computer the app runs on. On a server with no screen, such as a NAS, connect your laptop's Chrome first."}{" "}
              <Link href={APPLY_BROWSER_HREF} className="underline underline-offset-2 hover:text-ink">
                Change where it opens
              </Link>
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
            {!data.hasResume && <p className="text-sm text-muted">This application has no resume to attach yet. Write it on the Resume tab first.</p>}
            {job && !filling ? (
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
            {unsure && !findOwn && (
              <p className="text-meta text-pretty text-muted">
                {plan.host} doesn&apos;t look like {unsure.employer || "the employer"}&apos;s own site.{" "}
                <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => setFindOwn(true)}>
                  It&apos;s a copy of the ad
                </button>
              </p>
            )}
          </Panel>
          {unsure && findOwn && <FindPostingPanel applicationId={applicationId} plan={plan} find={unsure} />}
        </>
      )}

      {plan.kind === "email" && (
        <Panel title="Apply by email">
          <p className="text-sm text-pretty text-muted">
            This posting asks for applications by email, at <strong className="font-medium text-ink">{plan.to}</strong>. The Email tab writes the email
            {gmailSends ? " and sends it with your PDFs attached" : ", to send from your own mail with your PDFs attached"}, so there&apos;s no form to fill here.
          </p>
          <Button variant="secondary" className="mt-1 self-start" onClick={onGoToEmail}>
            Go to the Email tab
          </Button>
        </Panel>
      )}
      {plan.kind === "none" && (
        <Panel title="Apply by hand">
          <p className="text-sm text-pretty text-muted">
            No link to apply at was saved with this application, and the posting names no email address. Apply by hand with the PDFs from the
            Resume and Cover letter tabs, then mark it as sent.
          </p>
        </Panel>
      )}

      {latest && (!job || filling) && (
        <AttemptPanel
          attempt={latest}
          settling={settling}
          onSettle={settle}
          onRetry={plan.kind === "web" && channel !== "copy" ? start : undefined}
          fill={{ available: !job && !starting, running: filling, step: current, onFill: fill }}
        />
      )}

      <AnswersPanel answers={data.answers} autoSubmitOk={plan.kind === "web" && plan.autoSubmitOk} salaryGuide={data.salaryGuide ?? null} />

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
  fill,
}: {
  attempt: ApplyAttemptView;
  settling: boolean;
  onSettle: (attemptId: string, sent: boolean) => void;
  onRetry?: () => void;
  /** "Fill this page": whether it can start now, whether it is running (and at which step), and what starts it. */
  fill: { available: boolean; running: boolean; step: number; onFill: () => void };
}) {
  const canFill = attempt.watching && fill.available;
  const pages = pagesOf(attempt.filled);
  const shown = pages.length > 0 ? pages : [{ page: 1, entries: [] as ApplyAttemptView["filled"] }];
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
      {fill.running && <ProgressSteps steps={FILL_STEPS} current={fill.step} className="mt-1" />}
      {open && !attempt.watching && (
        <p className="text-sm text-muted">The server isn&apos;t watching the browser window any more (it was restarted), so Fill this page can&apos;t reach it. Say below how it ended.</p>
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
          <Button aria-disabled={!canFill || undefined} onClick={() => canFill && fill.onFill()}>
            {fill.running ? "Filling this page…" : "Fill this page"}
          </Button>
          <Button variant="secondary" aria-disabled={settling || undefined} onClick={() => !settling && onSettle(attempt.id, true)}>
            I sent it
          </Button>
          <Button variant="text" aria-disabled={settling || undefined} onClick={() => !settling && onSettle(attempt.id, false)}>
            I didn&apos;t send it
          </Button>
        </div>
      )}
      {canFill && (
        <p className="text-meta text-muted">Get to the form in the browser window, then click Fill this page. On the next step of a form, click it again.</p>
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
            What I filled in ({pages.length > 1 ? `${pages[0].entries.length} on this page, ${attempt.filled.length - pages[0].entries.length} earlier` : attempt.filled.length})
            {optional.length > 0 && <>, and {optional.length} optional {optional.length === 1 ? "field" : "fields"} I left</>}
          </summary>
          {shown.map((group, index) => (
            <div key={group.page} className={index > 0 ? "mt-3" : "mt-2"}>
              {pages.length > 1 && <h4 className="mb-1 text-meta text-muted">{index === 0 ? `This page · step ${group.page}` : `Earlier · step ${group.page}`}</h4>}
              <ul className="flex flex-col gap-1">
                {group.entries.map((entry, entryIndex) => (
                  <li key={entryIndex} className="flex flex-wrap gap-x-2">
                    <span className="text-ink">{entry.label}</span>
                    <span className="text-muted">
                      · {entry.what}
                      {entry.value && <> · {entry.value.length > 80 ? `${entry.value.slice(0, 80)}…` : entry.value}</>}
                    </span>
                  </li>
                ))}
                {index === 0 &&
                  optional.map((entry, optionalIndex) => (
                    <li key={`left-${optionalIndex}`} className="flex flex-wrap gap-x-2">
                      <span className="text-ink">{entry.label}</span>
                      <span className="text-muted">· left to you · {entry.reason}</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
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

/** The report's entries by the page of the form they were on, the page just filled first; a run from before pages were kept is one page. */
function pagesOf(filled: ApplyAttemptView["filled"]): { page: number; entries: ApplyAttemptView["filled"] }[] {
  const byPage = new Map<number, ApplyAttemptView["filled"]>();
  for (const entry of filled) byPage.set(entry.page ?? 1, [...(byPage.get(entry.page ?? 1) ?? []), entry]);
  return [...byPage].map(([page, entries]) => ({ page, entries })).sort((a, b) => b.page - a.page);
}

/** Where the standard answers are edited (jobauto fork): Settings, their one place. */
export const ANSWERS_HREF = "/settings?section=answers";

/**
 * The standard answers every form asks for (jobauto fork): read-only here,
 * as this application uses them, with the salary guide for this job beside
 * the salary; they're edited in one place, Settings → Standard answers.
 */
function AnswersPanel({
  answers,
  autoSubmitOk,
  salaryGuide,
}: {
  answers: ApplyAnswers;
  autoSubmitOk: boolean;
  /** What postings like this one pay (salary-guide.ts), beside the salary; null with too few. */
  salaryGuide: string | null;
}) {
  const level = (value: ApplyAnswers["germanLevel"]) => (value === "native" ? "Native" : value);
  const rows: { label: string; value: string; note?: string }[] = [
    { label: "Salary expectation", value: answers.salary, note: salaryGuide ? `Postings like this one: ${salaryGuide}.` : undefined },
    { label: "Earliest start date", value: answers.startDate },
    { label: "Notice period", value: answers.noticePeriod },
    { label: "German course", value: answers.germanCourse },
    { label: "Where you'd work", value: answers.mobility },
    { label: "Degree recognition", value: answers.degreeRecognition },
    { label: "German level", value: level(answers.germanLevel) },
    { label: "English level", value: level(answers.englishLevel) },
    { label: "Work permit", value: answers.workPermit ? "Allowed to work in Germany without sponsorship" : "Needs sponsorship" },
    { label: "Press Send for me", value: answers.autoSubmit ? (autoSubmitOk ? "On, and this site is one where it's safe" : "On, but on this site you press Send yourself") : "Off: you press Send yourself" },
  ];
  return (
    <Panel title="Your standard answers">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-pretty text-muted">
        <span>Used for every application: forms, the letter, call prep and your Kurzprofil. An empty one is left to you.</span>
        <Link href={ANSWERS_HREF} className="font-medium text-ink underline underline-offset-2">
          Edit them in Settings
        </Link>
      </p>
      {answers.confirmed === false && <p className="text-meta text-warning">Not saved yet: until they are, letters don&apos;t claim a work permit.</p>}
      <dl aria-label="Your standard answers" className="grid gap-x-6 gap-y-2.5 text-sm @min-[560px]:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-meta text-muted">{row.label}</dt>
            <dd className={cn("text-pretty", row.value ? "text-ink" : "text-muted italic")}>{row.value || "Not filled in"}</dd>
            {row.note && <dd className="text-meta text-pretty text-muted">{row.note}</dd>}
          </div>
        ))}
      </dl>
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

/**
 * Find the employer's posting (jobauto fork, "Apply at the source"): for a
 * link that is a copy of the ad on a site that collects job ads, or may be
 * one. The way to the employer's own posting (its careers page when she
 * follows it or it's in her field's list, else a web search in her own
 * browser), and a box for the link she finds, from which the way to send it
 * is worked out again. A copy stays one tap away.
 */
function FindPostingPanel({
  applicationId,
  plan,
  find,
}: {
  applicationId: string;
  plan: Extract<ApplyTabData["plan"], { kind: "web" }>;
  find: NonNullable<ApplyTabData["findPosting"]> | null;
}) {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [saving, startSaving] = useTransition();
  const copy = plan.owner?.kind === "copy" ? plan.owner.site : null;
  const employer = find?.employer || "the employer";

  const save = (chosen = link) => {
    if (!chosen.trim() || saving) return;
    startSaving(async () => {
      const result = await savePostingLink({ id: applicationId, link: chosen });
      if (!result.ok) return toast(result.error);
      if (result.toast) toast(result.toast);
      setLink("");
      router.refresh();
    });
  };

  return (
    <Panel title="Find the employer's posting" tone={copy ? "warning" : "plain"}>
      <p className="text-sm text-pretty text-muted">
        {copy ? (
          <>
            Apply where {employer}&apos;s recruiter reads applications: this job on {employer}&apos;s own site or its job system, not the copy on{" "}
            <strong className="font-medium text-ink">{copy}</strong>. Find it, then paste its link here.
          </>
        ) : (
          <>
            {plan.host} doesn&apos;t look like {employer}&apos;s own site. If it&apos;s a copy of the ad, find the posting on {employer}&apos;s site and paste its link
            here.
          </>
        )}
      </p>
      {/* The other places the portal listed it (jobauto fork, link-owner.ts), the employer's own first: one is a click instead of a search. */}
      {find?.listed && find.listed.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-meta text-muted">Also listed at</h3>
          <ul aria-label="Also listed at" className="flex flex-col divide-y divide-line">
            {find.listed.slice(0, 5).map((option) => (
              <li key={option.url} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
                <a href={option.url} target="_blank" rel="noopener noreferrer" className="min-w-0 break-all text-ink underline underline-offset-2">
                  {option.name || hostOf(option.url)}
                  {option.name && <span className="text-muted"> · {hostOf(option.url)}</span>}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <Button size="sm" variant="secondary" aria-label={`Use this link: ${option.name || hostOf(option.url)}`} aria-disabled={saving || undefined} onClick={() => save(option.url)}>
                  Use this link
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {find && (
        <div className="flex flex-wrap items-center gap-3">
          <a href={find.href} target="_blank" rel="noopener noreferrer" className={buttonClassName(copy ? "primary" : "secondary", "md", copy ? "hover:text-on-primary" : undefined)}>
            {find.via === "careers" ? `Open ${employer}'s careers page` : "Search for it"}
            <span aria-hidden>↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          {find.via === "search" && <span className="text-meta text-muted">Searches the web for the company, the role and &quot;Karriere&quot;.</span>}
        </div>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Input
          label="The employer's link"
          type="url"
          inputMode="url"
          placeholder="https://"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          className="min-w-0 flex-1 basis-64"
        />
        <Button type="submit" variant="secondary" aria-disabled={saving || !link.trim() || undefined}>
          {saving ? "Saving…" : "Use this link"}
        </Button>
      </form>
      {copy && (
        <p className="text-meta text-muted">
          <a href={plan.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-ink">
            Open the copy on {copy} anyway<span aria-hidden> ↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
    </Panel>
  );
}

/** "a, b and c" */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
