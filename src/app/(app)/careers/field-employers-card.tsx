"use client";

import Link from "next/link";
import { useState } from "react";

import { KnownPeople } from "@/components/known-people";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { FIELD_WORDS, fieldSearchHref, GERMAN_PLACES, type FieldEmployer } from "@/lib/careers/field-employers";
import type { EmployerView } from "@/lib/careers/store-types";
import type { Person } from "@/lib/network";

import { addEmployer } from "./actions";

/**
 * Employers in her field (jobauto fork, careers/field-employers.ts), on
 * Careers pages: where her kind of work is done in Germany. Those with a
 * feed the morning check reads can be followed in one click; every one can
 * be opened, or searched for on Positions.
 */
export function FieldEmployersCard({
  employers,
  followed,
  network,
  onFollowed,
}: {
  employers: readonly FieldEmployer[];
  /** The careers addresses followed already. */
  followed: ReadonlySet<string>;
  network: Record<string, Person[]>;
  onFollowed: (employer: EmployerView) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const follow = async (employer: FieldEmployer) => {
    if (!employer.followUrl || busy) return;
    setBusy(employer.name);
    const result = toastResult(await addEmployer({ name: employer.name, careersUrl: employer.followUrl, keywords: FIELD_WORDS, places: GERMAN_PLACES, notes: employer.why }));
    setBusy(null);
    if (!result.ok) return;
    onFollowed(result.data);
    toast(`Following ${employer.name}: its jobs in Germany with titles in your field are checked each morning.`);
  };

  return (
    <details className="group rounded-panel border border-line-card bg-card">
      <summary className="flex cursor-pointer list-none flex-col gap-1 p-6 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center justify-between gap-3">
          <span className="text-field font-medium">Employers in your field</span>
          <span aria-hidden className="text-meta text-muted group-open:hidden">
            Show {employers.length}
          </span>
        </span>
        <span className="text-meta text-muted">
          Where regulatory and transaction reporting, reconciliation and fund operations are done in Germany. Follow the ones whose jobs Dossier can read; open or search the others.
        </span>
      </summary>
      <ul aria-label="Employers in your field" className="flex flex-col divide-y divide-line border-t border-line">
        {employers.map((employer) => {
          const following = employer.followUrl ? followed.has(employer.followUrl) : false;
          return (
            <li key={employer.name} className="flex flex-col gap-2 px-6 py-4">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {employer.name} <span className="font-normal text-muted">· {employer.cities}</span>
                  </span>
                  <span className="text-meta text-muted">{employer.why}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a href={employer.careersUrl} target="_blank" rel="noopener noreferrer" className={buttonClassName("text", "sm")}>
                    Careers page{" "}
                    <span className="sr-only">of {employer.name} (opens in a new tab)</span>
                  </a>
                  <Link href={fieldSearchHref(employer)} className={buttonClassName("secondary", "sm")}>
                    Search{" "}
                    <span className="sr-only">{employer.name} on Positions</span>
                  </Link>
                  {employer.followUrl &&
                    (following ? (
                      <span className="text-meta text-muted">Following</span>
                    ) : (
                      <Button size="sm" aria-disabled={busy !== null || undefined} onClick={() => void follow(employer)}>
                        {busy === employer.name ? "Following…" : "Follow"}{" "}
                        <span className="sr-only">{employer.name}</span>
                      </Button>
                    ))}
                </div>
              </div>
              <KnownPeople people={network[employer.name] ?? []} compact />
            </li>
          );
        })}
      </ul>
    </details>
  );
}
