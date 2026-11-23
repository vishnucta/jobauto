"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { useJob } from "@/hooks/use-job";
import { cn } from "@/lib/cn";
import { needsYouHref, type NeedsYouItem } from "@/lib/dashboard";
import type { DoTodayRow } from "@/lib/do-today";
import { fieldLabel, STILL_OPEN } from "@/lib/field-match";
import type { TodayItem } from "@/lib/today";

import { prepareFieldPosting } from "./actions";
import { prepareAgentDraft } from "./agent/actions";
import { QuietDays } from "./quiet-days";

/** Rows shown before "Show all" (decided 16 November 2026, DB1). */
const DO_TODAY_LIMIT = 6;

/**
 * Do today (jobauto fork, do-today.ts): first on the dashboard, Needs you
 * (E28-4) and Today's three in one list, each thing once: what's due this
 * week on top, then what has no date, the job agent's drafts and matches
 * among them. Each row is one click from done; the whole row is the
 * button's link, but for a match, which has two buttons.
 */
export function DoToday({ rows, quietDays }: { rows: DoTodayRow[]; quietDays: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, DO_TODAY_LIMIT);
  return (
    <section aria-labelledby="do-today-heading" className="col-span-full flex flex-col rounded-panel border border-line-card bg-card px-6 pt-[22px] pb-3.5 max-sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pb-3">
        <h2 id="do-today-heading" className="font-serif text-section">
          Do today
        </h2>
        {/* Interview practice before there's a call: Call prep's general practice (jobauto fork). */}
        <Link href="/call-prep" className="text-meta text-muted underline underline-offset-3 hover:text-ink">
          Practise a first call
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-col gap-3 border-t border-line py-5">
          <p className="text-sm text-muted">All caught up. Nothing is waiting: run the job agent, or find a posting and start an application.</p>
          <div className="flex flex-wrap gap-2.5">
            <Link href="/agent" className={buttonClassName("secondary", "sm")}>
              Open the job agent
            </Link>
            <Link href="/jobs" className={buttonClassName("secondary", "sm")}>
              Open Positions
            </Link>
          </div>
        </div>
      ) : (
        <ul>
          {shown.map((row) =>
            row.kind === "needs" ? (
              <NeedsRow key={row.item.id} item={row.item} />
            ) : row.item.kind === "field" ? (
              <FieldRow key={row.item.postingId} item={row.item} />
            ) : (
              <AgentRow key={row.item.kind === "prepare" ? row.item.candidateId : row.item.applicationId} item={row.item} />
            ),
          )}
        </ul>
      )}
      {rows.length > DO_TODAY_LIMIT && (
        <button type="button" onClick={() => setAll(!all)} className="self-start py-2 text-meta text-muted underline underline-offset-3 hover:text-ink">
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
      <QuietDays days={quietDays} />
    </section>
  );
}

const rowClassName = "relative flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line py-[13px]";
/** On a phone the text wraps and the button goes under it, so neither is cut off (jobauto fork). */
const textClassName = "flex min-w-0 flex-1 flex-col gap-0.5 max-sm:basis-[calc(100%-1.75rem)]";
const actionClassName = "flex-none max-sm:pl-5";

/** A Needs you row (E28-4): its reason and when it's due, and the button that opens its application on the right tab. */
function NeedsRow({ item }: { item: NeedsYouItem }) {
  return (
    <li className={rowClassName}>
      <StatusDot status={item.status} />
      <div className={textClassName}>
        <p className="truncate text-field max-sm:whitespace-normal">
          <span className="font-medium">{item.company || item.role}</span>
          {item.company && item.role && <span className="text-muted"> · {item.role}</span>}
        </p>
        <p className="text-meta text-muted">
          {item.reason}
          {item.due && (
            <>
              {" · "}
              <span className={cn(item.soon && "text-warning")}>{item.due}</span>
            </>
          )}
        </p>
      </div>
      <div className={actionClassName}>
        <Link
          href={needsYouHref(item)}
          // The whole row opens it; only the button takes focus.
          className={buttonClassName("secondary", "sm", "after:absolute after:inset-0")}
        >
          {item.action} <span className="sr-only">for {[item.company, item.role].filter(Boolean).join(", ")}</span>
        </Link>
      </div>
    </li>
  );
}

/**
 * A posting in her field with no application yet (jobauto fork,
 * field-match.ts): the mark as Positions says it, that it is only a word
 * match until it's scored, and whether to check it is still open. Its
 * buttons are the posting itself, to read first, and Prepare.
 */
function FieldRow({ item }: { item: Extract<TodayItem, { kind: "field" }> }) {
  return (
    <li className={rowClassName}>
      <span aria-hidden="true" className="size-2 flex-none rounded-full border border-primary" />
      <div className={textClassName}>
        <p className="truncate text-field max-sm:whitespace-normal">
          <span className="font-medium">{item.company || item.title}</span>
          {item.company && <span className="text-muted"> · {item.title}</span>}
        </p>
        <p className="text-meta text-pretty text-muted">
          {fieldLabel(item.coverage)}: read the posting, then prepare it
          {item.coverage.total > 0 && ` · ${item.coverage.hit} of ${item.coverage.total} requirements covered`}
          {item.stale && (
            <>
              {" · "}
              <span className="text-warning">{STILL_OPEN}</span>
            </>
          )}
        </p>
      </div>
      <div className={actionClassName}>
        <PrepareButton item={item} />
      </div>
    </li>
  );
}

/** The job agent's draft to read and send, or its strong match to have it write (Today's three). */
function AgentRow({ item }: { item: Exclude<TodayItem, { kind: "finish" | "field" }> }) {
  const what = item.kind === "review" ? "The agent's draft: read it and send it" : "A strong match: let the agent write the draft";
  const name = [item.company, item.title].filter(Boolean).join(", ");
  return (
    <li className={rowClassName}>
      {item.kind === "review" ? <StatusDot status="DRAFT" /> : <span aria-hidden="true" className="size-2 flex-none rounded-full border border-primary" />}
      <div className={textClassName}>
        <p className="truncate text-field max-sm:whitespace-normal">
          <span className="font-medium">{item.company || item.title}</span>
          {item.company && <span className="text-muted"> · {item.title}</span>}
        </p>
        <p className="text-meta text-muted">
          {what}
          {item.coverage.total > 0 && ` · ${item.coverage.hit} of ${item.coverage.total} requirements covered`}
        </p>
      </div>
      <div className={actionClassName}>
        {item.kind === "prepare" ? (
          <PrepareButton item={item} />
        ) : (
          <Link href={`/applications/${item.applicationId}`} className={buttonClassName("primary", "sm", "after:absolute after:inset-0 hover:text-on-primary")}>
            Review <span className="sr-only">for {name}</span>
          </Link>
        )}
      </div>
    </li>
  );
}

/** Prepare: the job agent writes the draft for this match, as on the Agent screen; for a posting in her field, as Prepare it for me on Positions. */
function PrepareButton({ item }: { item: Extract<TodayItem, { kind: "prepare" | "field" }> }) {
  const router = useRouter();
  const [jobId, setJobId] = useState(item.jobId);
  const [starting, startTransition] = useTransition();
  const job = useJob<{ applicationId: string }>(jobId, 0, (update) => {
    if (update.status === "DONE") {
      setJobId(null);
      toast("The draft is ready for your review.");
      router.refresh();
    } else if (update.status === "FAILED") {
      setJobId(null);
      toast(update.error ?? "The draft couldn't be prepared.");
      router.refresh();
    }
  });
  const preparing = starting || Boolean(jobId);
  const prepare = () =>
    startTransition(async () => {
      const result = toastResult(item.kind === "field" ? await prepareFieldPosting({ postingId: item.postingId }) : await prepareAgentDraft({ candidateId: item.candidateId }));
      if (!result.ok) return;
      if (result.data.applicationId) router.refresh();
      else setJobId(result.data.jobId);
    });
  return (
    <div className="flex flex-wrap items-center gap-3">
      {preparing && job?.step && (
        <span role="status" className="text-meta text-muted">
          {job.step}
        </span>
      )}
      {item.url && (
        <a href={item.url} target="_blank" rel="noreferrer" className={buttonClassName("text", "sm")}>
          Posting
        </a>
      )}
      <Button size="sm" aria-disabled={preparing || undefined} onClick={() => !preparing && prepare()}>
        {preparing ? "Writing…" : "Prepare"}
      </Button>
    </div>
  );
}
