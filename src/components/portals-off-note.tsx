"use client";

import Link from "next/link";
import { useState } from "react";

import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { dismissPortalsOffNote } from "@/lib/job-search/portals-off-actions";
import { portalsLeftOffNote } from "@/lib/job-search/sources";

/**
 * The one-time note after the 1.15 upgrade (jobauto fork, portals-off.ts):
 * portals that have their key are switched off. On Positions it links to
 * Settings → Job search; there, the switches are right below. Dismiss hides
 * it for good. It never switches a portal on itself.
 */
export function PortalsOffNote({ names, inSettings = false, className }: { names: readonly string[]; inSettings?: boolean; className?: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const dismiss = async () => {
    setHidden(true);
    const result = await dismissPortalsOffNote({});
    if (!result.ok) {
      setHidden(false);
      toast(result.error);
    }
  };

  return (
    <div role="note" className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card bg-warning-surface px-4 py-3 text-meta text-warning", className)}>
      <p className="min-w-0 flex-[1_1_280px] text-pretty">
        {portalsLeftOffNote(names)} Switch {names.length === 1 ? "it" : "them"} on{" "}
        {inSettings ? (
          "below"
        ) : (
          <>
            in{" "}
            <Link href="/settings?section=jobs" className="font-medium text-warning underline underline-offset-2">
              Settings → Job search
            </Link>
          </>
        )}
        .
      </p>
      <Button variant="text" size="sm" className="flex-none text-warning hover:text-ink" onClick={() => void dismiss()}>
        Dismiss
      </Button>
    </div>
  );
}
