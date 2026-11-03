import Link from "next/link";

import { cn } from "@/lib/cn";
import { type JobsView, viewHref } from "@/lib/job-search/search";

/** How many each tab holds: searches kept, postings saved and dismissed, recruiters on the list. */
export type JobsCounts = { searches: number; saved: number; dismissed: number; recruiters: number };

/**
 * Find jobs' tabs: the search, past searches, the postings kept from them
 * (E14-7), and the recruiters to write to. The Recruiters tab is its own
 * screen (/recruiters), which shows these tabs too, so the two stay together.
 */
export function JobsTabs({ view, counts }: { view: JobsView | "recruiters"; counts: JobsCounts }) {
  const tabs = [
    // The latest search, as it was kept.
    { view: "search", label: "Search", href: "/jobs", count: null },
    { view: "history", label: "Past searches", href: viewHref("history"), count: counts.searches },
    { view: "saved", label: "Saved", href: viewHref("saved"), count: counts.saved },
    { view: "dismissed", label: "Dismissed", href: viewHref("dismissed"), count: counts.dismissed },
    { view: "recruiters", label: "Recruiters", href: "/recruiters", count: counts.recruiters },
  ] as const;
  return (
    <nav aria-label="Find jobs views" className="flex flex-wrap gap-1.5 px-10 pb-[18px]">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          href={tab.href}
          aria-current={tab.view === view ? "page" : undefined}
          className={cn(
            "flex items-baseline gap-1.5 rounded-control border px-3 py-2 text-control",
            tab.view === view ? "border-primary bg-selected font-medium text-primary-text hover:text-primary-text" : "border-line-field bg-card text-ink hover:border-line-strong hover:bg-hover hover:text-ink",
          )}
        >
          {tab.label}
          {tab.count !== null && <span className="text-xs opacity-65">{tab.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
