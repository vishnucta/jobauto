import Link from "next/link";

import { Building2, Users } from "lucide-react";

/** How many recruiters are on the list and careers pages are followed (jobauto fork). */
export type JobsCounts = { recruiters: number; employers: number };

/**
 * Positions' neighbours under Find work (jobauto fork): Recruiters and
 * Careers pages, screens of their own that Find jobs had as tabs. Quiet
 * links in the page bar, beside "Portals and scoring", with how many each
 * holds; the screen that's open leaves itself out, and its breadcrumb leads
 * back to Positions.
 */
export function FindWorkLinks({ counts, current }: { counts: JobsCounts; current?: "recruiters" | "careers" }) {
  const links = [
    { key: "recruiters", label: "Recruiters", href: "/recruiters", count: counts.recruiters, Icon: Users },
    { key: "careers", label: "Careers pages", href: "/careers", count: counts.employers, Icon: Building2 },
  ].filter((link) => link.key !== current);
  return (
    <nav aria-label="Also in Find work" className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {links.map(({ key, label, href, count, Icon }) => (
        <Link key={key} href={href} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <Icon size={14} aria-hidden="true" />
          {label}
          <span className="text-[12px] tabular-nums">{count}</span>
        </Link>
      ))}
    </nav>
  );
}
