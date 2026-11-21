"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { PageHeader } from "@/components/page-header";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { useJob } from "@/hooks/use-job";
import { BOARD_NAMES, type BoardKind } from "@/lib/careers/boards";
import type { CareersCheckResult } from "@/lib/careers/check-result";
import type { EmployerView } from "@/lib/careers/store-types";
import { formatDateTime } from "@/lib/dates";
import { libraryHref } from "@/lib/job-search/search";
import { CAREERS_SOURCE } from "@/lib/job-search/sources";

import { FindWorkLinks, type JobsCounts } from "../jobs/find-work-links";
import { addEmployer, checkCareers, deleteEmployer, saveEmployer, switchEmployer } from "./actions";

export type CareersScreenProps = {
  employers: EmployerView[];
  /** How many recruiters and careers pages there are, for the links beside Positions. */
  counts: JobsCounts;
  /** The profile's search words, for a new employer's words to start from. */
  suggestedWords: string;
  today: string;
  timeZone: string;
};

type Draft = { name: string; careersUrl: string; keywords: string; places: string };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const boardName = (ats: string) => BOARD_NAMES[ats as BoardKind] ?? ats;

/**
 * Careers pages (jobauto fork): the employers whose own careers pages are
 * checked once a day. Jobs show there days before the job boards have them,
 * and an application sent in the first days is read first. New ones land in
 * Positions; a screen of its own under it, which Find jobs had as a tab.
 */
export function CareersScreen({ employers: initial, counts, suggestedWords, today, timeZone }: CareersScreenProps) {
  const router = useRouter();
  const [employers, setEmployers] = useState(initial);
  // The check under way, and which employers it reads.
  const [check, setCheck] = useState<{ jobId: string; ids: string[] | null } | null>(null);
  const job = useJob<CareersCheckResult>(check?.jobId ?? null, 0, (view) => {
    if (view.status === "DONE" && view.result) {
      const result = view.result;
      setCheck(null);
      toast(result.message, result.searchId ? { action: { label: "Show them", onClick: () => router.push(libraryHref({ found: result.searchId! })) } } : undefined);
      router.refresh();
    } else if (view.status === "FAILED") {
      setCheck(null);
      toast(view.error ?? "The careers pages couldn't be checked. Try again.");
    }
  });
  const now = new Date(today);

  const startCheck = async (ids?: string[]) => {
    const result = toastResult(await checkCareers(ids ? { ids } : {}));
    if (result.ok) setCheck({ jobId: result.data.jobId, ids: ids ?? null });
  };
  const checking = (id: string) => check !== null && (check.ids === null || check.ids.includes(id));
  const replace = (saved: EmployerView) => setEmployers((list) => list.map((employer) => (employer.id === saved.id ? saved : employer)));

  return (
    <>
      <PageHeader
        title="Careers pages"
        breadcrumb={[{ label: "Positions", href: "/jobs" }, { label: "Careers pages" }]}
        actions={<FindWorkLinks counts={{ ...counts, employers: employers.length }} current="careers" />}
      />
      <div className="flex max-w-[860px] flex-col gap-5 px-10 pb-16">
        <p className="text-sm text-pretty text-muted">
          Follow the employers you&apos;d most like to work for. Their careers pages are checked every morning, and new jobs that match the words and places you give go into Positions as a
          search of their own, often days before job boards list them. Dossier reads Personio, Greenhouse, Lever, SmartRecruiters, Recruitee, Ashby and Workday pages, and pages that
          carry job data.
        </p>

        <AddEmployer suggestedWords={suggestedWords} onAdded={(employer) => setEmployers((list) => [...list, employer].sort((a, b) => a.name.localeCompare(b.name)))} />

        {employers.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" aria-disabled={check !== null || undefined} onClick={check ? undefined : () => void startCheck()}>
              {check?.ids === null ? (job?.step ?? "Checking…") : "Check all now"}
            </Button>
            <span className="text-meta text-muted">{plural(employers.filter((employer) => employer.enabled).length, "page is", "pages are")} checked each morning.</span>
          </div>
        )}

        <ul aria-label="Careers pages followed" className="flex flex-col gap-3">
          {employers.map((employer) => (
            <EmployerCard
              key={employer.id}
              employer={employer}
              now={now}
              timeZone={timeZone}
              checking={checking(employer.id)}
              step={check?.ids?.includes(employer.id) ? (job?.step ?? null) : null}
              onCheck={() => void startCheck([employer.id])}
              onSaved={replace}
              onRemoved={() => setEmployers((list) => list.filter((entry) => entry.id !== employer.id))}
            />
          ))}
        </ul>
      </div>
    </>
  );
}

function AddEmployer({ suggestedWords, onAdded }: { suggestedWords: string; onAdded: (employer: EmployerView) => void }) {
  const [draft, setDraft] = useState<Draft>({ name: "", careersUrl: "", keywords: suggestedWords, places: "" });
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    const result = toastResult(await addEmployer(draft));
    setSaving(false);
    if (!result.ok) return;
    onAdded(result.data);
    setDraft({ name: "", careersUrl: "", keywords: suggestedWords, places: draft.places });
    toast(`Following ${result.data.name}. Its page is read with the next check: press Check now to read it today.`);
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Follow an employer" className="grid gap-x-4 gap-y-3 rounded-panel border border-line-card bg-card p-6 sm:grid-cols-2">
      <Input
        label="Careers page"
        hint="The page that lists its jobs"
        placeholder="https://acme.jobs.personio.de"
        inputClassName="font-mono text-[13.5px]"
        spellCheck={false}
        value={draft.careersUrl}
        onChange={(event) => setDraft({ ...draft, careersUrl: event.target.value })}
      />
      <Input label="Employer" hint="Read from the address when left empty" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <Input label="Words in the title" hint="Comma-separated; empty takes every job" value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} />
      <Input label="Places" hint="E.g. Hamburg, Remote; empty takes every place" value={draft.places} onChange={(event) => setDraft({ ...draft, places: event.target.value })} />
      <Button type="submit" className="justify-self-start" aria-disabled={saving || undefined}>
        {saving ? "Adding…" : "Follow"}
      </Button>
    </form>
  );
}

function EmployerCard({
  employer,
  now,
  timeZone,
  checking,
  step,
  onCheck,
  onSaved,
  onRemoved,
}: {
  employer: EmployerView;
  now: Date;
  timeZone: string;
  checking: boolean;
  /** The step under way while this employer alone is being checked. */
  step: string | null;
  onCheck: () => void;
  onSaved: (employer: EmployerView) => void;
  onRemoved: () => void;
}) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const headingId = `employer-${employer.id}`;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const result = toastResult(await saveEmployer({ id: employer.id, ...editing }));
    if (!result.ok) return;
    onSaved(result.data);
    setEditing(null);
  };

  const toggle = async (enabled: boolean) => {
    const result = toastResult(await switchEmployer({ id: employer.id, enabled }));
    if (result.ok) onSaved(result.data);
  };

  const remove = async () => {
    const result = toastResult(await deleteEmployer({ id: employer.id }));
    if (result.ok) onRemoved();
  };

  const last = employer.lastCheckedAt
    ? `Checked ${formatDateTime(new Date(employer.lastCheckedAt), timeZone, now)}${employer.problem ? "" : `: ${plural(employer.lastMatched, "matching job", "matching jobs")}, ${employer.lastNew} new`}`
    : "Not checked yet";

  return (
    <li aria-labelledby={headingId} className="flex flex-col gap-3 rounded-panel border border-line-card bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-field font-medium">
            {employer.name}
          </h2>
          <p className="text-meta text-muted">
            {boardName(employer.ats)} ·{" "}
            <a href={employer.careersUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 [overflow-wrap:anywhere]">
              {employer.careersUrl}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
          <p className="text-meta text-muted">
            {[employer.keywords ? `Titles with ${employer.keywords}` : "Every job", employer.places ? `in ${employer.places}` : ""].filter(Boolean).join(" ")}
          </p>
        </div>
        <Toggle label={<span className="sr-only">Check {employer.name} each morning</span>} checked={employer.enabled} onCheckedChange={(enabled) => void toggle(enabled)} />
      </div>

      {employer.problem ? (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          {employer.problem}
        </p>
      ) : (
        <p className="text-meta text-muted">{checking ? (step ?? "Checking…") : last}</p>
      )}

      {editing ? (
        <form onSubmit={(event) => void save(event)} aria-label={`Edit ${employer.name}`} className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <Input label="Careers page" inputClassName="font-mono text-[13.5px]" spellCheck={false} value={editing.careersUrl} onChange={(event) => setEditing({ ...editing, careersUrl: event.target.value })} />
          <Input label="Employer" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
          <Input label="Words in the title" value={editing.keywords} onChange={(event) => setEditing({ ...editing, keywords: event.target.value })} />
          <Input label="Places" value={editing.places} onChange={(event) => setEditing({ ...editing, places: event.target.value })} />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button variant="text" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" aria-disabled={checking || undefined} onClick={checking ? undefined : onCheck}>
            {checking ? "Checking…" : "Check now"}
          </Button>
          {employer.lastNew > 0 && (
            <Link href={libraryHref({ portal: CAREERS_SOURCE })} className={buttonClassName("secondary", "sm")}>
              See what it found
            </Link>
          )}
          <Button variant="secondary" size="sm" onClick={() => setEditing({ name: employer.name, careersUrl: employer.careersUrl, keywords: employer.keywords, places: employer.places })}>
            Edit
          </Button>
          <Button ref={removeButton} variant="text" size="sm" onClick={() => setRemoving(true)}>
            Stop following
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Stop following ${employer.name}?`}
        description="Its careers page won't be checked any more. The jobs already found on it stay in Positions."
        confirmLabel="Stop following"
        onConfirm={() => void remove()}
        returnFocusTo={removeButton}
      />
    </li>
  );
}
