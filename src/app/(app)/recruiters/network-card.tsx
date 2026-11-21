"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";

import { forgetNetwork } from "./actions";

/**
 * Her LinkedIn network (jobauto fork), on Recruiters: she imports the
 * Connections.csv from LinkedIn's own data export, and every posting,
 * careers page, startup and application at an employer where she knows
 * someone says so. Kept only on this server; never sent to an AI.
 */
export function NetworkCard({ people, importedAt }: { people: number; importedAt: string | null }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    const response = await fetch("/api/network", { method: "POST", headers: { "content-type": "text/csv" }, body: file });
    const answer = (await response.json().catch(() => ({}))) as { people?: number; error?: string };
    setBusy(false);
    if (!response.ok) return void toast(answer.error ?? "The file couldn't be read. Try again.");
    toast(`Imported ${answer.people} ${answer.people === 1 ? "connection" : "connections"}.`);
    router.refresh();
  };

  const forget = async () => {
    if (toastResult(await forgetNetwork({})).ok) router.refresh();
  };

  return (
    <section aria-labelledby="network-card" className="flex flex-col gap-3 rounded-panel border border-line-card bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="network-card" className="font-serif text-lead">
            Your LinkedIn network
          </h2>
          <p className="text-meta text-pretty text-muted">
            {people > 0
              ? `${people} connections imported${importedAt ? ` on ${new Date(importedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}. Postings, careers pages, startups and applications at an employer where you know someone say so, with “Ask for a referral”.`
              : "Import your LinkedIn connections, and every posting, careers page, startup and application at an employer where you know someone says so. A referral is the quickest way in."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept=".csv,text/csv" hidden aria-label="LinkedIn Connections.csv" onChange={(event) => void upload(event)} />
          <Button variant="secondary" aria-disabled={busy || undefined} onClick={busy ? undefined : () => input.current?.click()}>
            {busy ? "Importing…" : people > 0 ? "Import again" : "Import Connections.csv"}
          </Button>
          {people > 0 && (
            <Button variant="text" onClick={() => void forget()}>
              Forget them
            </Button>
          )}
        </div>
      </div>
      {people === 0 && (
        <ol className="list-decimal pl-5 text-meta text-muted">
          <li>On LinkedIn: Settings &amp; Privacy → Data privacy → Get a copy of your data.</li>
          <li>Choose “Connections” only, and request the archive. LinkedIn emails a link, usually within minutes.</li>
          <li>Unzip it and import the Connections.csv here. Import it again now and then: it replaces the last one.</li>
        </ol>
      )}
      <p className="text-meta text-muted">
        Their names, employers and positions stay on this server, are left out of exports, and are never sent to an AI. Someone you ask for a referral becomes a contact on your
        list, like any recruiter you add: in exports, and visible to Claude through the MCP connector.
      </p>
    </section>
  );
}
