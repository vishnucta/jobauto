"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DocumentPreview } from "@/components/documents/document-preview";
import { DownloadPdfButton } from "@/components/documents/download-pdf-button";
import { WorkSampleDocument } from "@/components/documents/work-sample-document";
import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import type { PaperSize } from "@/generated/prisma/enums";
import { useJob } from "@/hooks/use-job";
import type { ThemeData } from "@/lib/themes";
import type { WorkSample } from "@/lib/work-sample";

import { putWorkSampleInMappe, writeWorkSample } from "./work-sample-actions";

export type WorkSampleTabData = {
  sample: WorkSample | null;
  /** The job writing it, e.g. since before a reload. */
  jobId: string | null;
};

/**
 * Work sample (jobauto fork): "My first 90 days" in this job, on one page,
 * to send with the application. It shows how she'd do the work, so the
 * reader weighs her competence rather than her German.
 */
export function WorkSampleTab({
  applicationId,
  data,
  aiReady,
  theme,
  name,
  paper,
  language,
}: {
  applicationId: string;
  data: WorkSampleTabData;
  aiReady: boolean;
  /** The cover letter's theme, which the sample is printed in. */
  theme: ThemeData | null;
  name: string;
  paper: PaperSize;
  language: string;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState(data.jobId);
  const [inMappe, setInMappe] = useState(data.sample?.inMappe ?? false);
  const job = useJob<WorkSample>(jobId, 0, (view) => {
    if (view.status === "DONE") {
      setJobId(null);
      router.refresh();
    } else if (view.status === "FAILED") {
      setJobId(null);
      toast(view.error ?? "The work sample couldn't be written. Try again.");
    }
  });

  const write = async () => {
    const result = toastResult(await writeWorkSample({ id: applicationId }));
    if (result.ok) setJobId(result.data.jobId);
  };

  const toggle = async (next: boolean) => {
    setInMappe(next);
    if (!toastResult(await putWorkSampleInMappe({ id: applicationId, inMappe: next })).ok) setInMappe(!next);
  };

  const writeButton = (label: string) =>
    aiReady ? (
      <Button variant={data.sample ? "secondary" : "primary"} size="sm" aria-disabled={jobId !== null || undefined} onClick={jobId ? undefined : () => void write()}>
        {jobId ? (job?.step ?? "Writing…") : label}
      </Button>
    ) : (
      <p className="text-meta text-warning">Set up an AI provider in Settings → AI provider first.</p>
    );

  if (!data.sample || !theme) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-10 py-8">
        <div className="flex max-w-[640px] flex-col gap-3 rounded-panel border border-line-card bg-card p-7">
          <h2 className="font-serif text-section">Show them how you&apos;d do the job</h2>
          <p className="text-sm text-pretty text-muted">
            A one-page “My first 90 days” for this job: what you&apos;d check, set up and deliver in each month, and where you&apos;ve done it before, from your profile only. Sent
            with the application, it moves the reader from your German to your competence. Written in the language of your documents.
          </p>
          {writeButton("Write my first 90 days")}
        </div>
      </div>
    );
  }

  return (
    <DocumentPreview
      label={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>Work sample</span>
          {writeButton("Write it again")}
          <DownloadPdfButton href={`/api/pdf?doc=sample&application=${applicationId}`} variant="secondary" progress="Rendering your work sample as a PDF…">
            Download PDF
          </DownloadPdfButton>
          <Toggle label={<span className="text-meta">In the Bewerbungsmappe</span>} checked={inMappe} onCheckedChange={(next) => void toggle(next)} />
        </span>
      }
      notice={
        data.sample.unverified.length > 0 ? (
          <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
            Check these against your profile before you send it: {data.sample.unverified.join(", ")}
          </p>
        ) : undefined
      }
    >
      <WorkSampleDocument sample={data.sample} name={name} theme={theme} paper={paper} language={language} />
    </DocumentPreview>
  );
}
