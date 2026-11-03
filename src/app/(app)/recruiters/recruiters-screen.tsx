"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";

import { DownloadPdfButton } from "@/components/documents/download-pdf-button";
import { PageHeader } from "@/components/page-header";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/cn";
import { formatDay } from "@/lib/dates";
import {
  followUpDue,
  gmailLink,
  listOrder,
  matchesFilter,
  nextStep,
  outreachDraft,
  SOURCE_LABEL,
  STARTER_RECRUITERS,
  STATUS_INFO,
  statusMoves,
  type OutreachFacts,
  type RecruiterFilter,
  type RecruiterStatusName,
  type RecruiterView,
} from "@/lib/recruiters/types";

import { JobsTabs, type JobsCounts } from "../jobs/jobs-tabs";
import { addRecruiter, addSuggestedRecruiters, deleteRecruiter, moveRecruiter, saveRecruiter, snoozeFollowUp } from "./actions";

export type RecruitersScreenProps = {
  recruiters: RecruiterView[];
  /** What a message may say about the user, from the profile. */
  facts: OutreachFacts;
  /** The Find jobs tabs' counts, since Recruiters is one of them. */
  counts: JobsCounts;
  today: string;
};

const FILTERS: { value: RecruiterFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "TO_CONTACT", label: "To contact" },
  { value: "WAITING", label: "Waiting" },
  { value: "REPLIED", label: "Replied" },
  { value: "DUE", label: "Follow-up due" },
];

const TONE = {
  ok: "text-success",
  warn: "text-warning",
  info: "text-status-sent",
  none: "text-muted",
} as const;

/**
 * Recruiters: the agencies and recruiters the user keeps track of, where each
 * conversation stands, when a follow-up is due, and the message to write
 * next, drafted from the profile. Dossier sends nothing: the message opens in
 * the user's own Gmail, and "I wrote to them" is the user's word.
 */
export function RecruitersScreen({ recruiters, facts, counts, today }: RecruitersScreenProps) {
  const router = useRouter();
  const now = new Date(today);
  const [filter, setFilter] = useState<RecruiterFilter>("ALL");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [busy, startTransition] = useTransition();

  const refresh = () => startTransition(() => router.refresh());
  const current = selected && selected !== "new" ? (recruiters.find((recruiter) => recruiter.id === selected) ?? null) : null;
  const visible = recruiters.filter((recruiter) => matchesFilter(recruiter, filter, now)).toSorted((a, b) => listOrder(a, now) - listOrder(b, now));
  const count = (value: RecruiterFilter) => recruiters.filter((recruiter) => matchesFilter(recruiter, value, now)).length;
  const missingStarters = STARTER_RECRUITERS.some((starter) => !recruiters.some((recruiter) => recruiter.name.trim().toLowerCase() === starter.name.toLowerCase()));

  const addSuggested = () =>
    startTransition(async () => {
      toastResult(await addSuggestedRecruiters({}));
      router.refresh();
    });

  return (
    <>
      <PageHeader
        title="Find jobs"
        description="Recruiters: agencies and recruiters who place people in your field. Ones that show up in your searches or jobs are added here. Keep track of whom you wrote to, see when a follow-up is due, and send each a message drafted from your profile. You send everything yourself."
        actions={
          <>
            {missingStarters && (
              <Button variant="secondary" aria-disabled={busy || undefined} onClick={() => !busy && addSuggested()}>
                Add suggested agencies
              </Button>
            )}
            <Button onClick={() => setSelected("new")}>Add a recruiter</Button>
          </>
        }
      />
      <JobsTabs view="recruiters" counts={counts} />
      <div className="flex flex-col gap-6 px-10 pb-20">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Summary">
          <Stat label="on your list" value={recruiters.length} />
          <Stat label="contacted" value={recruiters.filter((recruiter) => recruiter.status === "CONTACTED" || recruiter.status === "REPLIED").length} />
          <Stat label="replied" value={count("REPLIED")} />
          <Stat label="follow-ups due" value={count("DUE")} />
        </dl>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <section aria-labelledby="recruiters-list" className="flex min-w-0 flex-col gap-3 rounded-panel border border-line-card bg-card p-5">
            <h2 id="recruiters-list" className="font-serif text-lead">
              Your list
            </h2>
            <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
              {FILTERS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cn(
                    "flex items-baseline gap-1.5 rounded-full border px-3 py-1 text-control",
                    filter === option.value ? "border-primary bg-selected font-medium text-primary-text" : "border-line-field bg-card text-ink hover:border-line-strong hover:bg-hover",
                  )}
                >
                  {option.label}
                  <span className="text-xs opacity-65">{count(option.value)}</span>
                </button>
              ))}
            </div>
            {visible.length === 0 ? (
              <p className="py-6 text-sm text-muted">
                {recruiters.length === 0
                  ? "No recruiters yet. Add the agencies suggested for finance in Hamburg, or add one you know."
                  : "Nobody matches this filter."}
              </p>
            ) : (
              <ul className="flex flex-col">
                {visible.map((recruiter) => (
                  <li key={recruiter.id} className="border-t border-line first:border-t-0">
                    <RecruiterRow recruiter={recruiter} now={now} selected={recruiter.id === selected} onSelect={() => setSelected(recruiter.id)} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="min-w-0">
            {selected === "new" ? (
              <RecruiterForm
                key="new"
                recruiter={null}
                title="New recruiter"
                onSaved={(saved) => {
                  setSelected(saved.id);
                  refresh();
                }}
                onCancel={() => setSelected(null)}
              />
            ) : current ? (
              <RecruiterDetail
                key={current.id}
                recruiter={current}
                facts={facts}
                now={now}
                onChanged={refresh}
                onGone={() => {
                  setSelected(null);
                  refresh();
                }}
              />
            ) : (
              <p className="rounded-panel border border-line-card bg-card p-5 text-sm text-muted">
                {recruiters.length === 0 ? "Add a recruiter to start." : "Pick a recruiter to see the message to write, and the history."}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-line-card bg-card px-4 py-3">
      <dd className="font-serif text-section leading-none tabular-nums">{value}</dd>
      <dt className="pt-1 text-meta text-muted">{label}</dt>
    </div>
  );
}

function Pill({ status, due }: { status: RecruiterStatusName; due: boolean }) {
  const { label, tone } = due ? { label: "Follow-up due", tone: "warn" as const } : STATUS_INFO[status];
  return <span className={cn("self-start rounded-full border border-current px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", TONE[tone])}>{label}</span>;
}

function RecruiterRow({ recruiter, now, selected, onSelect }: { recruiter: RecruiterView; now: Date; selected: boolean; onSelect: () => void }) {
  const due = followUpDue(recruiter, now);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn("grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 rounded-control px-2 py-3 text-left hover:bg-hover", selected && "bg-selected")}
    >
      <span className="truncate font-medium">{recruiter.name}</span>
      <Pill status={recruiter.status} due={due} />
      {(recruiter.speciality || SOURCE_LABEL[recruiter.source]) && (
        <span className="col-span-2 truncate text-meta text-muted">{[recruiter.speciality, SOURCE_LABEL[recruiter.source]].filter(Boolean).join(" · ")}</span>
      )}
      <span className={cn("col-span-2 text-meta", due ? "font-medium text-warning" : "text-muted")}>{nextStep(recruiter, now)}</span>
    </button>
  );
}

function RecruiterDetail({ recruiter, facts, now, onChanged, onGone }: { recruiter: RecruiterView; facts: OutreachFacts; now: Date; onChanged: () => void; onGone: () => void }) {
  const headingId = useId();
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const moves = statusMoves(recruiter.status);

  const move = (status: RecruiterStatusName) =>
    startTransition(async () => {
      if (toastResult(await moveRecruiter({ id: recruiter.id, status })).ok) onChanged();
    });
  const snooze = () =>
    startTransition(async () => {
      if (toastResult(await snoozeFollowUp({ id: recruiter.id })).ok) onChanged();
    });
  const remove = () =>
    startTransition(async () => {
      if (toastResult(await deleteRecruiter({ id: recruiter.id })).ok) onGone();
    });

  const kind = recruiter.status === "CONTACTED" ? "follow-up" : recruiter.status === "NOT_CONTACTED" ? "first" : null;

  return (
    <section role="region" aria-labelledby={headingId} className="flex min-w-0 flex-col gap-5 rounded-panel border border-line-card bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="font-serif text-lead text-pretty">
            {recruiter.name}
          </h2>
          <p className="text-meta text-muted">{nextStep(recruiter, now)}</p>
        </div>
        <Pill status={recruiter.status} due={followUpDue(recruiter, now)} />
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Where it stands">
        {moves.map((move_) => (
          <Button key={`${move_.to}:${move_.label}`} variant="secondary" size="sm" aria-disabled={pending || undefined} onClick={() => !pending && move(move_.to)}>
            {move_.label}
          </Button>
        ))}
        {recruiter.status === "CONTACTED" && (
          <Button variant="secondary" size="sm" aria-disabled={pending || undefined} onClick={() => !pending && snooze()}>
            Snooze 3 days
          </Button>
        )}
      </div>

      {kind ? (
        <Draft
          key={`${recruiter.id}:${kind}:${recruiter.contactedAt}:${recruiter.contactName}:${recruiter.speciality}:${recruiter.email}`}
          recruiter={recruiter}
          kind={kind}
          facts={facts}
        />
      ) : recruiter.status === "REPLIED" ? (
        <p className="text-sm text-muted">They replied. Write back from your own mail, then press “I wrote again” to start the next follow-up.</p>
      ) : null}

      <RecruiterForm key={`${recruiter.id}:${recruiter.name}:${recruiter.email}:${recruiter.contactName}:${recruiter.website}:${recruiter.speciality}:${recruiter.notes}`} recruiter={recruiter} title="Details" onSaved={onChanged} />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">History</h3>
        <ol className="flex flex-col gap-1 text-meta">
          {recruiter.events.map((event) => (
            <li key={event.id} className="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
              <time dateTime={event.at} className="text-muted tabular-nums">
                {formatDay(new Date(event.at), undefined, now)}
              </time>
              <span>{event.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <div>
        <Button ref={removeButton} variant="danger-text" size="sm" onClick={() => setRemoving(true)}>
          Remove from the list
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${recruiter.name}?`}
        description="Dossier deletes what it keeps about this recruiter: the details, your notes and the history. It stays off the list even if a later search shows it again, until you add it yourself. Nothing you sent is affected."
        confirmLabel="Remove"
        onConfirm={remove}
        returnFocusTo={removeButton}
      />
    </section>
  );
}

/** The message to write next, drafted from the profile and open to edits; it goes out from the user's own Gmail. */
function Draft({ recruiter, kind, facts }: { recruiter: RecruiterView; kind: "first" | "follow-up"; facts: OutreachFacts }) {
  const initial = outreachDraft(recruiter, kind, facts);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${subject}\n\n${body}`);
      toast("Copied. Paste it into your mail.");
    } catch {
      toast("Couldn't copy. Select the text and copy it.");
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-card border border-line-card p-4">
      <h3 className="text-sm font-medium">{kind === "follow-up" ? "Follow-up, ready to review" : "First message, ready to review"}</h3>
      <p className="text-meta text-muted">Written from your profile only. Read it, change what you like, and attach your resume before you send.</p>
      <Input label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
      <Textarea label="Message" rows={11} value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <a href={gmailLink(recruiter.email, subject, body)} target="_blank" rel="noopener noreferrer" className={buttonClassName("primary", "md")}>
          Open in Gmail
        </a>
        <Button variant="secondary" size="md" onClick={() => void copy()}>
          Copy message
        </Button>
        <DownloadPdfButton href="/api/pdf?doc=base" variant="secondary">
          Download your resume
        </DownloadPdfButton>
      </div>
      {!recruiter.email && <p className="text-meta text-muted">There is no email for them yet. Add one under Details, or paste the message into your mail.</p>}
    </div>
  );
}

function RecruiterForm({ recruiter, title, onSaved, onCancel }: { recruiter: RecruiterView | null; title: string; onSaved: (saved: RecruiterView) => void; onCancel?: () => void }) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    name: recruiter?.name ?? "",
    contactName: recruiter?.contactName ?? "",
    email: recruiter?.email ?? "",
    website: recruiter?.website ?? "",
    speciality: recruiter?.speciality ?? "",
    notes: recruiter?.notes ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<string, string[]>>>({});
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    startTransition(async () => {
      const result = recruiter ? await saveRecruiter({ id: recruiter.id, ...form }) : await addRecruiter(form);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        return toast(result.error);
      }
      setErrors({});
      toast(recruiter ? "Saved." : "Recruiter added.");
      onSaved(result.data);
    });
  };

  return (
    <form onSubmit={submit} aria-label={title} className={cn("flex flex-col gap-3", !recruiter && "rounded-panel border border-line-card bg-card p-5")}>
      <h3 className={cn(recruiter ? "text-sm font-medium" : "font-serif text-lead")}>{title}</h3>
      <Input label="Agency or recruiter" value={form.name} error={errors.name?.[0]} onChange={(event) => set({ name: event.target.value })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Contact person" value={form.contactName} placeholder="Optional" onChange={(event) => set({ contactName: event.target.value })} />
        <Input label="Email" type="email" value={form.email} error={errors.email?.[0]} placeholder="Only one they published" onChange={(event) => set({ email: event.target.value })} />
      </div>
      <Input label="Website" value={form.website} error={errors.website?.[0]} placeholder="https://" onChange={(event) => set({ website: event.target.value })} />
      <Input label="Places people in" value={form.speciality} placeholder="e.g. Finance & accounting, Hamburg" onChange={(event) => set({ speciality: event.target.value })} />
      <Textarea label="Notes" rows={3} value={form.notes} maxLength={5_000} onChange={(event) => set({ notes: event.target.value })} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="md" aria-disabled={pending || undefined}>
          {recruiter ? "Save details" : "Add recruiter"}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
