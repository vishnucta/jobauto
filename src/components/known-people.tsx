"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { knownLine, type Person } from "@/lib/network";

import { askForReferral } from "@/app/(app)/recruiters/actions";

/**
 * "You know someone here" (jobauto fork): the people from her LinkedIn
 * network at an employer, on a posting, a careers page, a startup or an
 * application, each with "Ask for a referral", which puts them on
 * Recruiters with the message ready.
 */
export function KnownPeople({ people, compact = false }: { people: readonly Person[]; compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (people.length === 0) return null;

  const ask = async (person: Person) => {
    if (busy) return;
    setBusy(person.id);
    const result = toastResult(await askForReferral({ connectionId: person.id }));
    setBusy(null);
    if (!result.ok) return;
    toast(result.data.added ? `${person.name} is on Recruiters now, with the referral message ready.` : `${person.name} is on Recruiters already.`, {
      action: { label: "Open", onClick: () => router.push("/recruiters") },
    });
  };

  return (
    <div role="note" aria-label="People you know here" className={compact ? "flex flex-col gap-1.5 text-meta" : "flex flex-col gap-2 rounded-card bg-track px-4 py-3 text-meta"}>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span>
          <span className="font-medium text-ink">You know someone here:</span> {knownLine(people)}
        </span>
        <button type="button" aria-expanded={open} className="underline underline-offset-2 hover:text-ink" onClick={() => setOpen(!open)}>
          {open ? "Hide" : people.length === 1 ? "Ask for a referral" : "See who"}
        </button>
      </p>
      {open && (
        <ul className="flex flex-col gap-1.5">
          {people.map((person) => (
            <li key={person.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {person.url ? (
                  <a href={person.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                    {person.name} <span className="sr-only">on LinkedIn (opens in a new tab)</span>
                  </a>
                ) : (
                  person.name
                )}
                {person.position && <span className="text-muted"> · {person.position}</span>}
              </span>
              <Button variant="secondary" size="sm" aria-disabled={busy === person.id || undefined} onClick={() => void ask(person)}>
                Ask for a referral <span className="sr-only">from {person.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
