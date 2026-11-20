"use client";

import Link from "next/link";
import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import type { SavedAgentSearch } from "@/lib/agent/search";
import type { AgentSource } from "@/lib/agent/source";
import { AGENT_MAX_SOURCE_REQUESTS_PER_DAY } from "@/lib/agent/limits";
import type { Country } from "@/lib/job-search/countries";
import type { JobSource, SearchQuery } from "@/lib/job-search/search";
import type { Scorer } from "@/lib/scoring/scorers";

import { saveAgentSettings } from "../agent/actions";
import { PhoneAlerts, type PhoneAlertSettings } from "./phone-alerts";
import { SupporterDigest, type SupporterDigestSettings } from "./supporter-digest";
import { RecurringSearches } from "./recurring-searches";
import { SETTINGS_SECTIONS, settingsSectionHref, type SettingsSectionId } from "./sections";
import { SettingsSectionIntro } from "./settings-screen";

const SOURCE_NAMES: Record<AgentSource, string> = { JSEARCH: "JSearch", SERPAPI: "SerpApi", ADZUNA: "Adzuna", JOOBLE: "Jooble", FREEHIRE: "FreeHire" };

export type AgentSettings = {
  enabled: boolean;
  hour: number;
  minScore: number;
  maxScores: number;
  maxDrafts: number;
  autoDraft: boolean;
  /** The agent's own source; null or missing is Automatic. */
  source?: AgentSource | null;
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MIN_SCORES = [50, 55, 60, 65, 70, 75, 80, 85, 90];
const SCORE_COUNTS = Array.from({ length: 30 }, (_, index) => index + 1);
const DRAFT_COUNTS = Array.from({ length: 11 }, (_, index) => index);
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * Shared daily schedule and AI limits, with explicit saved-search management.
 */
export function AgentSection({
  initial,
  source,
  agentSource,
  scoring,
  countries,
  timeZone,
  onlyWhileOpen = false,
  searches,
  suggestedQuery,
  alerts,
  supporter,
}: {
  initial: AgentSettings;
  /** The source in Settings → Job search; null while job search is off. */
  source: JobSource | null;
  /**
   * The agent's own source (agent/source.ts): what's chosen (null is
   * Automatic), what it searches in effect, and what she could choose.
   */
  agentSource?: { chosen: AgentSource | null; effective: AgentSource | null; choices: AgentSource[] };
  /** What scores the postings (Settings → Scoring), and whether it's set up. */
  scoring: { scorer: Scorer; ready: boolean };
  countries: readonly Country[];
  /** The user's time zone, which the hour is in. */
  timeZone: string;
  /** In the desktop app on this computer, where it only runs while the app is open (#325). */
  onlyWhileOpen?: boolean;
  searches: SavedAgentSearch[];
  suggestedQuery?: SearchQuery;
  /** Phone alerts for strong matches and new jobs on careers pages. */
  alerts: PhoneAlertSettings;
  /** The weekly digest for her supporter; missing in older callers. */
  supporter?: SupporterDigestSettings;
}) {
  const track = useTrackSave();
  const [settings, setSettings] = useState(initial);

  const change = (next: Partial<AgentSettings>) => {
    const previous = settings;
    setSettings({ ...settings, ...next });
    void track(saveAgentSettings(next)).then((result) => {
      if (!toastResult(result).ok) setSettings(previous);
    });
  };

  return (
    <>
      <SettingsSectionIntro title="Job agent">
        Once a day it runs all enabled searches, scores the new postings against your profile, and keeps the best on the Agent screen. It never sends or applies.
      </SettingsSectionIntro>

      {source === "ARBEITSAGENTUR" && agentSource?.effective ? null : source === "ARBEITSAGENTUR" ? (
        // It searches on its own, which the BA's terms forbid most clearly (#223).
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          The agent doesn&apos;t search the Bundesagentur für Arbeit. Choose JSearch, SerpApi, Adzuna or FreeHire in{" "}
          <Link href="/settings?section=jobs" className="font-medium text-warning underline underline-offset-2">
            Settings → Job search
          </Link>{" "}
          for it. Manual Find jobs searches are unaffected.
        </p>
      ) : !source ? (
        <SetupNote before="The agent searches the source you choose in " section="jobs" after=", which is off. Choose one first." />
      ) : scoring.ready ? null : scoring.scorer === "JEV" ? (
        <SetupNote before="The agent scores postings with Jev, which needs your TypeSafe key in " section="scoring" after="." />
      ) : (
        <SetupNote before="The agent scores postings with the AI provider in " section="ai" after=", which isn't set up yet. Choose one first." />
      )}

      <Card padding="none" className="px-7 py-4">
        <Toggle
          label="Run the job agent"
          description={
            settings.enabled
              ? `On. It runs once a day after ${clock(settings.hour)} your time (${timeZone}), and you can run it now and then on the Agent screen.${
                  onlyWhileOpen ? " On this computer, only while Dossier is open: when it's closed at that hour, the run starts once you open it, the same day." : ""
                }`
              : "Off. Nothing is searched or scored until it's on."
          }
          checked={settings.enabled}
          onCheckedChange={(enabled) => change({ enabled })}
        />
      </Card>

      {agentSource && (
        <Card padding="none" className="flex flex-col gap-2 px-7 py-[22px]">
          <Select
            label="Searches with"
            className="max-w-[420px]"
            value={settings.source ?? ""}
            onChange={(event) => change({ source: (event.target.value || null) as AgentSource | null })}
          >
            <option value="">Automatic{agentSource.effective && !settings.source ? ` (${SOURCE_NAMES[agentSource.effective]})` : ""}</option>
            {agentSource.choices.map((choice) => (
              <option key={choice} value={choice}>
                {SOURCE_NAMES[choice]}
              </option>
            ))}
          </Select>
          <p className="text-meta text-muted">
            {source === "ARBEITSAGENTUR"
              ? "Find jobs searches the Bundesagentur, which the agent may not search on its own, so it uses one of your other sources. Automatic takes the first with a key."
              : "Automatic searches the same source as Find jobs. Choose another to keep the agent on a source of its own."}
          </p>
        </Card>
      )}

      <RecurringSearches initial={searches} suggestedQuery={suggestedQuery} source={agentSource?.effective ?? source} countries={countries} />

      <Card padding="none" className="grid gap-x-[18px] gap-y-5 px-7 py-[26px] sm:grid-cols-2">
        <Select label="Runs after" hint={`Your time (${timeZone})`} value={String(settings.hour)} onChange={(event) => change({ hour: Number(event.target.value) })}>
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {clock(hour)}
            </option>
          ))}
        </Select>
        <Select
          label="Minimum score"
          hint="Postings scored lower stay out of the queue."
          value={String(settings.minScore)}
          onChange={(event) => change({ minScore: Number(event.target.value) })}
        >
          {[...new Set([...MIN_SCORES, settings.minScore])].sort((a, b) => a - b).map((score) => (
            <option key={score} value={score}>
              {score} of 100
            </option>
          ))}
        </Select>
        <Select label="Postings scored per run" value={String(settings.maxScores)} onChange={(event) => change({ maxScores: Number(event.target.value) })}>
          {SCORE_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </Select>
        <Select
          label="Drafts per run, at most"
          value={String(settings.maxDrafts)}
          disabled={!settings.autoDraft}
          hint={settings.autoDraft ? undefined : "Turn on Prepare drafts on its own first"}
          onChange={(event) => change({ maxDrafts: Number(event.target.value) })}
        >
          {DRAFT_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </Select>
        <Toggle
          className="sm:col-span-2"
          label="Prepare drafts on its own"
          description={
            settings.autoDraft
              ? `For the best new postings of each run, up to ${plural(settings.maxDrafts, "draft", "drafts")}: a tailored resume and cover letter, waiting for your review.`
              : "Off. You choose which postings get a draft with Prepare draft."
          }
          checked={settings.autoDraft}
          onCheckedChange={(autoDraft) => change({ autoDraft })}
        />
      </Card>

      <PhoneAlerts initial={alerts} />
      {supporter && <SupporterDigest initial={supporter} />}

      <p className="text-meta text-muted">
        One shared daily schedule for all enabled searches, in {timeZone}. Each search requests only the first page, sequentially. At most {AGENT_MAX_SOURCE_REQUESTS_PER_DAY} source requests in any rolling 24 hours, including failed attempts. A run waits until the whole batch fits. Across all searches, each run scores up to {plural(settings.maxScores, "posting", "postings")}
        {settings.autoDraft ? ` and prepares up to ${plural(settings.maxDrafts, "draft", "drafts")}` : ""}. Scoring uses the provider in Settings → Scoring; drafts use your AI provider. Both receive your profile; the job source only gets the search.
      </p>
    </>
  );
}

/** What the agent still needs, with a link to the section that sets it up. */
function SetupNote({ before, section, after }: { before: string; section: SettingsSectionId; after: string }) {
  return (
    <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
      {before}
      <Link href={settingsSectionHref(section)} className="font-medium text-warning underline underline-offset-2">
        Settings → {SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label}
      </Link>
      {after}
    </p>
  );
}
