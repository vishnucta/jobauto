"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { useJob } from "@/hooks/use-job";
import type { TodayItem } from "@/lib/today";

import { prepareAgentDraft } from "./agent/actions";

const card = "flex flex-col rounded-panel border border-line-card bg-card";

/**
 * Today's three (jobauto fork), first on the dashboard: the three things
 * that get applications out today (today.ts), each one click from done.
 */
export function TodayCard({ items }: { items: TodayItem[] }) {
  return (
    <section aria-labelledby="today-heading" className={`${card} col-span-full gap-4 px-7 py-6`}>
      <div className="flex flex-col gap-1">
        <h2 id="today-heading" className="font-serif text-section">
          Today&apos;s three
        </h2>
        <p className="text-meta text-muted">
          {items.length > 0
            ? "Send these and today counted. Your own drafts first, then the agent's, then its best matches still to write."
            : "Nothing is waiting. Run the job agent, or find a posting and start an application."}
        </p>
      </div>
      {items.length > 0 ? (
        <ol className="flex flex-col divide-y divide-line">
          {items.map((item, index) => (
            <TodayRow key={item.kind === "prepare" ? item.candidateId : item.applicationId} item={item} number={index + 1} />
          ))}
        </ol>
      ) : (
        <div className="flex flex-wrap gap-2.5">
          <Link href="/agent" className={buttonClassName("secondary", "sm")}>
            Open the job agent
          </Link>
          <Link href="/jobs" className={buttonClassName("secondary", "sm")}>
            Open Positions
          </Link>
        </div>
      )}
    </section>
  );
}

function TodayRow({ item, number }: { item: TodayItem; number: number }) {
  const what = item.kind === "finish" ? "Your draft: finish it and send it" : item.kind === "review" ? "The agent's draft: read it and send it" : "A strong match: let the agent write the draft";
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-track text-meta font-medium">
        {number}
      </span>
      {/* On a phone the title wraps and the button goes under it, so neither is cut off (jobauto fork). */}
      <div className="flex min-w-0 flex-1 flex-col max-sm:basis-[calc(100%-2.75rem)]">
        <span className="truncate font-medium max-sm:whitespace-normal">
          {item.title}
          {item.company && <span className="font-normal text-muted"> · {item.company}</span>}
        </span>
        <span className="text-meta text-muted">
          {what}
          {item.kind !== "finish" && item.coverage.total > 0 && ` · ${item.coverage.hit} of ${item.coverage.total} requirements covered`}
        </span>
      </div>
      <div className="flex-none max-sm:pl-11">
        {item.kind === "prepare" ? (
          <PrepareButton item={item} />
        ) : (
          <Link href={`/applications/${item.applicationId}`} className={buttonClassName("primary", "sm", "hover:text-on-primary")}>
            {item.kind === "finish" ? "Finish" : "Review"}
          </Link>
        )}
      </div>
    </li>
  );
}

function PrepareButton({ item }: { item: Extract<TodayItem, { kind: "prepare" }> }) {
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
      const result = toastResult(await prepareAgentDraft({ candidateId: item.candidateId }));
      if (!result.ok) return;
      if (result.data.applicationId) router.refresh();
      else setJobId(result.data.jobId);
    });
  return (
    <div className="flex items-center gap-3">
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
