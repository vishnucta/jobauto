"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { CheckFix, CheckItem, CheckLevel, RequirementCheck, ResumeCheck } from "@/lib/resume-check";

// The ATS check's report (src/lib/resume-check.ts) above a resume preview:
// three headed lists, each item with its verdict and, where a switch or a
// setting puts it right, the button or link to it. The report names things
// by their labels and counts, so nothing here quotes the document.

const DOT: Record<CheckLevel, string> = { ok: "text-success", warn: "text-warning", fail: "text-error" };

const LINK = "whitespace-nowrap text-ink underline underline-offset-2 hover:text-ink";

/** "14:32": when the check ran, so a report left open doesn't pass for a fresh one. Only ever rendered in the browser, after a check. */
const checkedAt = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** The verdict at a glance; the title says it in words, so the dot is decoration. */
function Dot({ level }: { level: CheckLevel }) {
  return <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full bg-current", DOT[level])} />;
}

export function ResumeCheckCard({
  report,
  onFix,
  fixing = false,
  stale = false,
}: {
  report: ResumeCheck;
  /** A fix button was pressed: the screen has the switch or setting it names. */
  onFix: (fix: CheckFix) => void;
  /** A fix is being applied, so the buttons wait. */
  fixing?: boolean;
  /** The resume changed since the check, so the report is about an earlier one. */
  stale?: boolean;
}) {
  const headingId = useId();
  const pages = `${report.pages} ${report.pages === 1 ? "page" : "pages"}`;
  const control = (fix: CheckFix) => fixControl(fix, report.document, onFix, fixing);
  return (
    <section role="region" aria-labelledby={headingId} className="flex flex-col gap-4 rounded-card border border-line-card bg-card px-4 py-3 text-meta">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-sm font-medium text-ink">
          ATS check
        </h2>
        {/* The pages before the file name: a line ending in "· 2 pages" reads as the preview's own count. */}
        <span className="text-muted">
          Checked at {checkedAt(report.checkedAt)} · {pages} · {report.fileName}
        </span>
      </div>
      {stale && <p className="text-warning">The resume changed since this check — run it again.</p>}
      <Group title="Reads correctly">
        {report.reads.map((item) => (
          <Item key={item.id} item={item} control={control} />
        ))}
      </Group>
      {report.requirements && (
        <Group title="Says what the posting asks for" aside={`${report.requirements.named} of ${report.requirements.total} named`}>
          {report.requirements.items.map((item) => (
            <RequirementRow key={item.index} item={item} onFix={onFix} fixing={fixing} />
          ))}
        </Group>
      )}
      <Group title="Clean text">
        {report.text.map((item) => (
          <Item key={item.id} item={item} control={control} />
        ))}
      </Group>
    </section>
  );
}

function Group({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 className="font-medium text-ink">{title}</h3>
        {aside && <span className="text-muted">{aside}</span>}
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </div>
  );
}

function Item({ item, control }: { item: CheckItem; control: (fix: CheckFix) => ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Dot level={item.level} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ink">{item.title}</span>
        {item.detail && <span className="text-muted">{item.detail}</span>}
      </span>
      {item.fix && <span className="shrink-0">{control(item.fix)}</span>}
    </li>
  );
}

/** "Named in the resume", or why not and whether the profile could back it. */
function verdict({ named, inProfile, skill }: RequirementCheck): string {
  if (named) return "Named in the resume";
  if (!inProfile) return "Not named, and not in your profile";
  return skill ? `Not named; your profile has it as “${skill}”` : "Not named, though your profile has it";
}

/**
 * One requirement of the posting, the job title first (index -1). Only one
 * the profile backs gets the offers: the resume can't claim what the user
 * doesn't have.
 */
function RequirementRow({ item, onFix, fixing }: { item: RequirementCheck; onFix: (fix: CheckFix) => void; fixing: boolean }) {
  const offers: { label: string; fix: CheckFix }[] =
    item.named || !item.inProfile
      ? []
      : [
          ...(item.skill ? [{ label: "Add to Skills", fix: { kind: "add-skill", skill: item.skill } as const }] : []),
          { label: "Mention in the summary", fix: { kind: "mention", term: item.skill ?? item.requirement } as const },
        ];
  return (
    <li className="flex items-start gap-2">
      <Dot level={item.named ? "ok" : "warn"} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ink">{item.index === -1 ? `Job title: ${item.requirement}` : item.requirement}</span>
        <span className="text-muted">{verdict(item)}</span>
      </span>
      {offers.length > 0 && (
        <span className="flex shrink-0 flex-wrap justify-end gap-2">
          {offers.map(({ label, fix }) => (
            <Button key={label} variant="secondary" size="sm" aria-disabled={fixing || undefined} onClick={() => !fixing && onFix(fix)}>
              {label}
            </Button>
          ))}
        </span>
      )}
    </li>
  );
}

/** The control for a fix: a button for a switch the screen has, a link to where the setting lives, or a line saying where. */
function fixControl(fix: CheckFix, document: ResumeCheck["document"], onFix: (fix: CheckFix) => void, fixing: boolean): ReactNode {
  const button = (label: string) => (
    <Button variant="secondary" size="sm" aria-disabled={fixing || undefined} onClick={() => !fixing && onFix(fix)}>
      {label}
    </Button>
  );
  switch (fix.kind) {
    case "settings":
      return (
        <Link href="/settings?section=documents" className={LINK}>
          Open Settings → Documents
        </Link>
      );
    case "theme":
      return <span className="text-muted">Pick a single-column theme in the Themes panel.</span>;
    case "photo":
      // The base resume follows the profile's "Show on resumes", which lives on the Profile screen.
      return document === "base" ? (
        <Link href="/profile?section=basics" className={LINK}>
          Turn the photo off in your profile
        </Link>
      ) : (
        button("Hide the photo")
      );
    case "single-column":
      return button("Use a single column");
    case "language":
      return button(`Set the language to ${fix.language}`);
    case "add-skill":
      return button("Add to Skills");
    case "mention":
      return button("Mention in the summary");
    case "clean-up":
      return button("Clean up the text");
  }
}
