import Link from "next/link";

import { cn } from "@/lib/cn";
import { type JobsView, viewHref } from "@/lib/job-search/search";

/** How many each tab holds: searches kept, postings saved and dismissed, recruiters on the list, careers pages followed. */
export type JobsCounts = { searches: number; saved: number; dismissed: number; recruiters: number; employers?: number };

/**
 * Find jobs' tabs: the search, past searches, the postings kept from them
 * (E14-7), the recruiters to write to, and the careers pages followed. The
 * Recruiters and Careers pages tabs are screens of their own (/recruiters,
 * /careers), which show these tabs too, so they stay together.
 */
export function JobsTabs({ view, counts }: { view: JobsView | "recruiters" | "careers"; counts: JobsCounts }) {
  const tabs = [
    // The latest search, as it was kept.
    { view: "search", label: "Search", href: "/jobs", count: null },
    { view: "history", label: "Past searches", href: viewHref("history"), count: counts.searches },
    { view: "saved", label: "Saved", href: viewHref("saved"), count: counts.saved },
    { view: "dismissed", label: "Dismissed", href: viewHref("dismissed"), count: counts.dismissed },
    { view: "recruiters", label: "Recruiters", href: "/recruiters", count: counts.recruiters },
    { view: "careers", label: "Careers pages", href: "/careers", count: counts.employers ?? null },
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
