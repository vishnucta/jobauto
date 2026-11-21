"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { levelRangeLabel } from "@/lib/profile-levels";
import type { ScoringOffNotice as Notice } from "@/lib/scoring-off";

import { guessProfileLevels } from "./profile/profiles-actions";

/**
 * "Scoring is off" (jobauto fork, scoring-off.ts): on Positions, the Agent
 * screen, the dashboard and Settings → Scoring while a profile scored
 * against has no levels. It stays until they're chosen: Choose levels opens
 * Profile → Jobs it's for, and Guess with AI, when Dossier's AI model can,
 * fills them in from the profile's roles, as that page's button does.
 */
export function ScoringOffNotice({ off, className }: { off: Notice; className?: string }) {
  const router = useRouter();
  const [guessing, setGuessing] = useState(false);

  const guess = async () => {
    setGuessing(true);
    const result = toastResult(await guessProfileLevels({ profileId: off.profileId }));
    setGuessing(false);
    if (!result.ok) return;
    toast(`Levels set to ${levelRangeLabel(result.data)}. Change them in Profile → Jobs it's for.`);
    router.refresh();
  };

  return (
    <section aria-label="Scoring is off" className={cn("flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-warning-line bg-warning/10 px-5 py-4", className)}>
      <span aria-hidden="true" className="font-semibold text-warning">
        !
      </span>
      <p className="min-w-0 flex-[1_1_240px] text-sm text-pretty">
        <span className="font-medium">{off.title}</span> <span className="text-muted">{off.body}</span>
      </p>
      <div className="flex flex-none flex-wrap items-center gap-2">
        <Link href={off.href} className={buttonClassName("primary", "sm", "hover:text-on-primary")}>
          Choose levels
        </Link>
        {off.canGuess && (
          <Button variant="secondary" size="sm" aria-disabled={guessing || undefined} onClick={() => !guessing && void guess()}>
            {guessing ? "Guessing…" : "Guess with AI"}
          </Button>
        )}
      </div>
    </section>
  );
}
