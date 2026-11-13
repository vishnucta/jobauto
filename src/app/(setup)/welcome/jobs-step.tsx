"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { JobSearchSettingsView } from "@/lib/job-search/sources";
import { JOB_CHOICES, JOB_KINDS, JOB_SOURCES_HELP, type JobChoice, type JobKind } from "@/lib/setup/job-choices";

import { saveJobSearchDetails, saveJobSource, saveJobSourceKey, testJobSource } from "../../(app)/settings/actions";
import { ChoiceCards } from "./choice-cards";
import { InstructionList } from "./instruction-list";

type Status = { state: "idle" } | { state: "checking" } | { state: "connected" } | { state: "failed"; message: string };

const kindOf = (source: JobSearchSettingsView["source"]): JobKind | null =>
  source === "OFF" ? "none" : (JOB_CHOICES.find((choice) => choice.source === source)?.kind ?? null);

/** The guide's job search step (E21-3): what kind of jobs, then the source for it and its key, checked at once. */
export function JobsStep({ initial }: { initial: JobSearchSettingsView }) {
  const router = useRouter();
  const [kind, setKind] = useState<JobKind | null>(kindOf(initial.source));
  const [source, setSource] = useState<JobChoice["source"] | null>(JOB_CHOICES.find((choice) => choice.source === initial.source)?.source ?? null);
  const choices = JOB_CHOICES.filter((choice) => choice.kind === kind);

  const chooseKind = async (next: JobKind) => {
    setKind(next);
    if (next === "none") {
      setSource(null);
      if (toastResult(await saveJobSource({ source: "OFF" })).ok) router.refresh();
      return;
    }
    setSource(JOB_CHOICES.find((choice) => choice.kind === next)!.source);
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lead font-medium">What kind of jobs are you looking for?</h2>
        <ChoiceCards label="What kind of jobs are you looking for?" options={JOB_KINDS} value={kind} onChange={(next) => void chooseKind(next)} />
      </section>
      {kind === "any" && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lead font-medium">Pick one</h2>
          <ChoiceCards
            label="Pick a job source"
            options={choices.map((choice) => ({ value: choice.source, name: choice.name, description: choice.about }))}
            value={source}
            onChange={setSource}
          />
        </section>
      )}
      {source && kind !== "none" && <SourcePanel key={source} choice={JOB_CHOICES.find((choice) => choice.source === source)!} initial={initial} onConnected={() => router.refresh()} />}
    </div>
  );
}

function SourcePanel({ choice, initial, onConnected }: { choice: JobChoice; initial: JobSearchSettingsView; onConnected: () => void }) {
  const [appId, setAppId] = useState(initial.adzuna.appId);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const savedKey = choice.source === "ADZUNA" ? initial.adzuna.keyState : initial.jsearch.keyState;

  const connect = async () => {
    setStatus({ state: "checking" });
    const steps = [
      () => saveJobSource({ source: choice.source }),
      ...(choice.source === "ADZUNA" ? [() => saveJobSearchDetails({ adzunaAppId: appId })] : []),
      ...(choice.source === "JSEARCH" ? [() => saveJobSearchDetails({ jsearchHost: "openwebninja" })] : []),
      ...(choice.source !== "FREEHIRE" && key.trim() ? [() => saveJobSourceKey({ source: choice.source as "ADZUNA" | "JSEARCH", change: { action: "set", value: key } })] : []),
    ];
    for (const step of steps) {
      if (!toastResult(await step()).ok) return setStatus({ state: "idle" });
    }
    const result = toastResult(await testJobSource({}));
    if (!result.ok) return setStatus({ state: "idle" });
    if (result.data.connected) {
      setKey("");
      setStatus({ state: "connected" });
      onConnected();
    } else {
      setStatus({ state: "failed", message: result.data.message });
    }
  };

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-serif text-section">{choice.name}</h2>
        <p className="text-sm text-pretty text-muted">{choice.about}</p>
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[140px_1fr]">
        <dt className="font-medium">What it costs</dt>
        <dd className="text-pretty text-muted">{choice.cost}</dd>
        <dt className="font-medium">Your data</dt>
        <dd className="text-pretty text-muted">Your searches (keywords, place and filters) go to {choice.name}. Nothing from your profile does.</dd>
      </dl>
      <InstructionList steps={choice.steps} label={`Setting up ${choice.name}`} />
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (status.state !== "checking") void connect();
        }}
      >
        {choice.source === "ADZUNA" && <Input label="Application ID" autoComplete="off" value={appId} onChange={(event) => setAppId(event.target.value)} />}
        {choice.source !== "FREEHIRE" && (
          <Input
            label={choice.source === "ADZUNA" ? "Application key" : "JSearch API key"}
            type="password"
            autoComplete="off"
            placeholder={savedKey === "set" ? "Saved · paste a new one to replace it" : "Paste it here"}
            hint="Stored encrypted on your server, and never shown again."
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        )}
        <Button type="submit" className="self-start" aria-disabled={status.state === "checking" || undefined}>
          {status.state === "checking" ? "Checking…" : choice.source === "FREEHIRE" ? "Use FreeHire" : "Check it"}
        </Button>
      </form>
      <div role="status" className="text-sm empty:hidden">
        {status.state === "connected" && <p className="text-success">It works: Dossier can search {choice.name}.</p>}
        {status.state === "failed" && <p className="rounded-card bg-warning-surface px-4 py-3 font-medium text-warning">{status.message}</p>}
      </div>
      <a href={JOB_SOURCES_HELP} target="_blank" rel="noopener noreferrer" className="self-start text-meta text-muted underline underline-offset-2 hover:text-ink">
        More help on the wiki <span className="sr-only">(opens in a new tab)</span>
      </a>
    </Card>
  );
}
