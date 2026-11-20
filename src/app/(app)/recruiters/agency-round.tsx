"use client";

import { useState } from "react";

import { DownloadPdfButton } from "@/components/documents/download-pdf-button";
import { toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { gmailLink, outreachDraft, type OutreachFacts, type RecruiterView } from "@/lib/recruiters/types";

import { moveRecruiter } from "./actions";

/**
 * The agency round (jobauto fork): every agency on the list not written to
 * yet, with its first message ready, and the one-page Kurzprofil agencies
 * pitch candidates with. She opens each message in her own Gmail, attaches
 * the Kurzprofil and her resume, sends it, and ticks it off. Nothing is
 * sent by Dossier.
 */
export function AgencyRound({ recruiters, facts, onChanged }: { recruiters: RecruiterView[]; facts: OutreachFacts; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const toWrite = recruiters.filter((recruiter) => recruiter.kind === "AGENCY" && recruiter.status === "NOT_CONTACTED");

  const wrote = async (recruiter: RecruiterView) => {
    if (busy) return;
    setBusy(recruiter.id);
    const result = toastResult(await moveRecruiter({ id: recruiter.id, status: "CONTACTED" }));
    setBusy(null);
    if (result.ok) onChanged();
  };

  return (
    <section aria-labelledby="agency-round" className="flex flex-col gap-3 rounded-panel border border-line-card bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="agency-round" className="font-serif text-lead">
            Your Kurzprofil, and the agencies to write to
          </h2>
          <p className="text-meta text-pretty text-muted">
            German agencies pitch candidates to employers with a one-page profile. Yours is made from your profile and your standard answers.{" "}
            {toWrite.length > 0
              ? `${toWrite.length === 1 ? "One agency is" : `${toWrite.length} agencies are`} still to write to: open each message, attach the Kurzprofil and your resume, and send it from your own mail.`
              : "Every agency on your list has heard from you."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DownloadPdfButton href="/api/pdf?doc=kurzprofil" variant="secondary" progress="Making your Kurzprofil…">
            Kurzprofil (PDF)
          </DownloadPdfButton>
          {toWrite.length > 0 && (
            <Button variant="secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Hide the agencies" : `Write to ${toWrite.length === 1 ? "it" : `all ${toWrite.length}`}`}
            </Button>
          )}
        </div>
      </div>
      {open && toWrite.length > 0 && (
        <ul aria-label="Agencies to write to" className="flex flex-col">
          {toWrite.map((recruiter) => {
            const draft = outreachDraft(recruiter, "first", facts);
            return (
              <li key={recruiter.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-2.5 first:border-t-0">
                <span className="min-w-0">
                  <span className="font-medium">{recruiter.name}</span>
                  <span className="text-meta text-muted"> · {[recruiter.contactName, recruiter.email || "no address yet"].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="flex flex-wrap gap-2">
                  <a href={gmailLink(recruiter.email, draft.subject, draft.body)} target="_blank" rel="noopener noreferrer" className={buttonClassName("secondary", "sm")}>
                    Open in Gmail <span className="sr-only">for {recruiter.name}</span>
                  </a>
                  <Button size="sm" aria-disabled={busy === recruiter.id || undefined} onClick={() => void wrote(recruiter)}>
                    I wrote to them <span className="sr-only">({recruiter.name})</span>
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
