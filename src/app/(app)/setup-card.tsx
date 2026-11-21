"use client";

import Link from "next/link";

import { buttonClassName } from "@/components/ui/button";
import type { SetupStep } from "@/lib/setup-checklist";

/**
 * Start here (jobauto fork, setup-checklist.ts): on the dashboard until
 * every way in is in use. Done steps fold away; each open one is a click.
 * The weekly target's leads to the This week card, its one control.
 */
export function SetupCard({ steps }: { steps: SetupStep[] }) {
  const open = steps.filter((step) => !step.done);
  if (open.length === 0) return null;
  const done = steps.length - open.length;

  return (
    <section aria-labelledby="setup-heading" className="col-span-full flex flex-col gap-4 rounded-panel border border-line-card bg-card px-7 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="setup-heading" className="font-serif text-section">
          Start here
        </h2>
        <span className="text-meta text-muted">
          {done} of {steps.length} done
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-line">
        {open.map((step) => (
          <li key={step.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
            {/* On a phone the button goes under its text, which keeps the width (jobauto fork). */}
            <div className="flex min-w-0 flex-1 flex-col max-sm:basis-full">
              <span className="font-medium">{step.title}</span>
              <span className="text-meta text-muted">{step.why}</span>
            </div>
            <Link href={step.href} className={buttonClassName("secondary", "sm")}>
              {step.action}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
