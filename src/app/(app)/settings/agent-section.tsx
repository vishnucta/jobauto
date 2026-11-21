"use client";

import Link from "next/link";
import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import type { SavedAgentSearch } from "@/lib/agent/search";
import type { AgentPortalsView } from "@/lib/agent/source";
import { AGENT_MAX_SOURCE_REQUESTS_PER_DAY } from "@/lib/agent/limits";
import type { Country } from "@/lib/job-search/countries";
import type { JobSource, SearchQuery } from "@/lib/job-search/search";
import type { Scorer } from "@/lib/scoring/scorers";

import { saveAgentSettings } from "../agent/actions";
import { RecurringSearches, type SearchProfile } from "./recurring-searches";
import { SETTINGS_SECTIONS, settingsSectionHref, type SettingsSectionId } from "./sections";
import { SettingsSectionIntro } from "./settings-screen";
import { COVERS, COVERS_LABELS, type Covers } from "@/lib/posting-coverage";

export type AgentSettings = {
  enabled: boolean;
  hour: number;
  /** The queue's cut-off (E32-2). */
  covers: Covers;
  maxScores: number;
  maxDrafts: number;
  autoDraft: boolean;
  /** Which new matches get a Strong new matches message, through Settings → Notifications (jobauto fork). */
  strongCovers: Covers;
  /** The agent's own portals (agent/source.ts, jobauto fork); null or missing is Automatic. */
  portals?: string[] | null;
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
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
  sources,
  portals,
  scoring,
  countries,
  timeZone,
  onlyWhileOpen = false,
  searches,
  suggestedQuery,
  profiles = [],
}: {
  initial: AgentSettings;
  /** The source in Settings → Job search; null while job search is off. */
  source: JobSource | null;
  /** The portals the agent asks, which its search form follows (#517): its own when it has some (jobauto fork). */
  sources: readonly JobSource[];
  /** What "Searches with" offers (agent/source.ts, jobauto fork): what Automatic asks, and the portals she could choose. */
  portals?: AgentPortalsView;
  /** What scores the postings (Settings → Scoring), and whether it's set up. */
  scoring: { scorer: Scorer; ready: boolean };
  countries: readonly Country[];
  /** The user's time zone, which the hour is in. */
  timeZone: string;
  /** In the desktop app on this computer, where it only runs while the app is open (#325). */
  onlyWhileOpen?: boolean;
  searches: SavedAgentSearch[];
  suggestedQuery?: SearchQuery;
  /** Every profile, with what a search tied to it starts with (E24-6). */
  profiles?: SearchProfile[];
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
  // Its own portals (jobauto fork), kept in the order Settings → Job search lists them.
  const own = settings.portals ?? null;
  const inOrder = (ids: readonly string[]) => (portals?.choices ?? []).map((choice) => choice.id).filter((id) => ids.includes(id));
  const nameOf = (id: string) => portals?.choices.find((choice) => choice.id === id)?.name ?? id;
  // On Automatic with only the Bundesagentur switched on, a portal she has a key for stands in (source.ts).
  const standIn = !source && !own && (portals?.automatic.length ?? 0) > 0;

  return (
    <>
      <SettingsSectionIntro title="Job agent">
        Once a day it runs all enabled searches, scores the new postings against your profile, and keeps the best on the Agent screen. It never sends or applies.
      </SettingsSectionIntro>

      {own && sources.length === 0 ? (
        <SetupNote before="None of the portals chosen for the agent below can be searched now. Check their keys in " section="jobs" after=", or choose others." />
      ) : source === "ARBEITSAGENTUR" && !standIn ? (
        // It searches on its own, which the BA's terms forbid most clearly (#223).
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          The agent doesn&apos;t search the Bundesagentur für Arbeit. Choose JSearch, SerpApi, Adzuna or FreeHire in{" "}
          <Link href="/settings?section=jobs" className="font-medium text-warning underline underline-offset-2">
            Settings → Job search
          </Link>{" "}
          for it. Manual Find jobs searches are unaffected.
        </p>
      ) : !source && !standIn && !own ? (
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

      {/* The agent's own portals (jobauto fork): Automatic, or portals of its own, switched on in Settings → Job search or not. */}
      {portals && (
        <Card padding="none" className="flex flex-col gap-3 px-7 py-[22px]">
          <Select
            label="Searches with"
            className="max-w-[420px]"
            value={own ? "own" : ""}
            onChange={(event) =>
              change({ portals: event.target.value ? (portals.automatic.length > 0 ? [...portals.automatic] : portals.choices.slice(0, 1).map((choice) => choice.id)) : null })
            }
          >
            <option value="">Automatic{portals.automatic.length > 0 ? ` (${portals.automatic.map(nameOf).join(", ")})` : ""}</option>
            <option value="own" disabled={!own && portals.choices.length === 0}>
              Portals of its own
            </option>
          </Select>
          {own && (
            <div role="group" aria-label="The job agent's portals" className="flex flex-col gap-2">
              {portals.choices.map((choice) => {
                const on = own.includes(choice.id);
                return (
                  <Checkbox
                    key={choice.id}
                    label={choice.name}
                    checked={on}
                    // At least one: Automatic is the way back to none of its own.
                    disabled={on && own.length === 1}
                    onChange={(event) => change({ portals: event.target.checked ? inOrder([...own, choice.id]) : own.filter((id) => id !== choice.id) })}
                  />
                );
              })}
            </div>
          )}
          <p className="text-meta text-muted">
            {own
              ? "The agent asks only these, switched on in Settings → Job search or not, so its requests stay apart from your searches in Positions. Each portal you have a key for, and FreeHire, can be chosen; never the Bundesagentur für Arbeit."
              : standIn
                ? "Settings → Job search has only the Bundesagentur für Arbeit switched on, which the agent may not search on its own, so it uses a portal you have a key for."
                : "Automatic asks every portal switched on in Settings → Job search, except the Bundesagentur für Arbeit. Choose portals of its own to keep the agent apart from your searches."}
          </p>
        </Card>
      )}

      <RecurringSearches initial={searches} suggestedQuery={suggestedQuery} sources={sources} countries={countries} profiles={profiles} />

      <Card padding="none" className="grid gap-x-[18px] gap-y-5 px-7 py-[26px] sm:grid-cols-2">
        <Select label="Runs after" hint={`Your time (${timeZone})`} value={String(settings.hour)} onChange={(event) => change({ hour: Number(event.target.value) })}>
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {clock(hour)}
            </option>
          ))}
        </Select>
        <Select
          label="Keep postings that cover"
          hint="How much of what a posting asks for the profile must cover to wait in the queue. One that lists no requirements is never drafted on its own."
          value={settings.covers}
          onChange={(event) => change({ covers: event.target.value as Covers })}
        >
          {COVERS.map((value) => (
            <option key={value} value={value}>
              {value === "any" ? "Any amount" : `${COVERS_LABELS[value]} of the requirements`.replace("All of them of the requirements", "All of the requirements")}
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
              : "Off. You choose which postings get a draft with Prepare it for me."
          }
          checked={settings.autoDraft}
          onCheckedChange={(autoDraft) => change({ autoDraft })}
        />
      </Card>

      {/* What counts as a strong match (jobauto fork): only the threshold. Notifications delivers the Strong new matches event, to the channels that have it on. */}
      <Card padding="none" className="flex flex-col gap-2 px-7 py-[26px]">
        <Select
          label="A new match is strong when it covers"
          hint="This only says which new finds count as strong. After each run, Run now too, they go out as Strong new matches."
          value={settings.strongCovers}
          onChange={(event) => change({ strongCovers: event.target.value as Covers })}
        >
          {COVERS.map((value) => (
            <option key={value} value={value}>
              {value === "any" ? "Any amount" : `${COVERS_LABELS[value]} of the requirements`.replace("All of them of the requirements", "All of the requirements")}
            </option>
          ))}
        </Select>
        <p className="text-meta text-muted">
          Where they go, if anywhere, is set in{" "}
          <Link href={settingsSectionHref("notifications")} className="font-medium text-ink underline underline-offset-2">
            Settings → Notifications
          </Link>
          , as is the weekly digest for a supporter.
        </p>
      </Card>

      <p className="text-meta text-muted">
        One shared daily schedule for all enabled searches, in {timeZone}. Each search asks every portal the agent searches with that covers its country for the first page (never the Bundesagentur für Arbeit), and what it finds lands in Positions. At most {AGENT_MAX_SOURCE_REQUESTS_PER_DAY} requests to each portal in any rolling 24 hours, including failed attempts. A run waits until the whole batch fits. Across all searches, each run scores up to {plural(settings.maxScores, "posting", "postings")}
        {settings.autoDraft ? ` and prepares up to ${plural(settings.maxDrafts, "draft", "drafts")}` : ""}. Scoring uses the provider in Settings → Scoring; drafts use your AI provider. Both receive your profile; the portals only get the search.
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
