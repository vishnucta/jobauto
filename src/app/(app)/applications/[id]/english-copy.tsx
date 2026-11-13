"use client";

import { useEffect, useId, useRef, useState } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import type { DocumentKind } from "@/generated/prisma/enums";
import { useJob } from "@/hooks/use-job";

import { readInEnglish } from "./english-copy-actions";

type Copy = { parts: { label: string; text: string }[] };

/**
 * "Read in English" above a document written in another language (jobauto
 * fork): the same document in English, for her to read exactly what she
 * sends. It's never saved in the document and never sent.
 */
export function EnglishCopy({ applicationId, kind, what }: { applicationId: string; kind: DocumentKind; what: string }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [copy, setCopy] = useState<Copy | null>(null);
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const close = useRef<HTMLButtonElement>(null);
  const job = useJob<Copy>(jobId, 0, (view) => {
    if (view.status === "DONE" && view.result) {
      setJobId(null);
      setCopy(view.result);
      setOpen(true);
    } else if (view.status === "FAILED") {
      setJobId(null);
      toast(view.error ?? "It couldn't be written in English. Try again.");
    }
  });

  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const start = async () => {
    if (copy) return setOpen(true);
    const result = toastResult(await readInEnglish({ id: applicationId, kind }));
    if (result.ok) setJobId(result.data.jobId);
  };

  return (
    <>
      <Button variant="text" size="sm" aria-disabled={jobId !== null || undefined} onClick={jobId ? undefined : () => void start()}>
        {jobId ? (job?.step ?? "Writing it in English…") : "Read in English"}
      </Button>
      {open && copy && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            className="flex max-h-[85vh] w-full max-w-[680px] flex-col gap-4 overflow-y-auto rounded-panel border border-line-card bg-card p-7"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id={headingId} className="font-serif text-section">
                  Your {what} in English
                </h2>
                <p className="text-meta text-muted">To read what you send. It isn&apos;t saved in the {what}, and it isn&apos;t sent.</p>
              </div>
              <Button ref={close} variant="secondary" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
            {copy.parts.map((part, index) => (
              <div key={index} className="flex flex-col gap-1">
                <p className="text-label text-muted">{part.label}</p>
                <p className="text-sm whitespace-pre-line">{part.text}</p>
              </div>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
