"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Toggle } from "@/components/ui/toggle";
import { FORK_REPOSITORY_URL, REPOSITORY_URL, UPGRADE_GUIDE_URL, type Release } from "@/lib/releases";

import { checkUpdates, updateSettings } from "./actions";
import { SettingsSectionIntro } from "./settings-screen";

export type AboutFacts = { label: string; value: string }[];

/** The update check as the server sees it. */
export type UpdatesView = {
  /** "Check for updates daily". */
  daily: boolean;
  /** A newer release than this one, if a check has found one. */
  available: Release | null;
};

type Check = { status: "idle" } | { status: "checking" } | { status: "latest" } | ({ status: "newer" } & Release) | { status: "unknown" };

const LINK = "font-medium text-ink underline underline-offset-2";

/**
 * Settings → About (E10-9, SET-12): facts about this install, and the update
 * check: daily while it's on, and whenever asked.
 */
export function AboutSection({ facts, updates }: { facts: AboutFacts; updates: UpdatesView }) {
  const [check, setCheck] = useState<Check>(updates.available ? { status: "newer", ...updates.available } : { status: "idle" });
  const [daily, setDaily] = useState(updates.daily);
  const track = useTrackSave();

  const run = async () => {
    setCheck({ status: "checking" });
    const result = await checkUpdates({});
    setCheck(result.ok ? result.data : { status: "unknown" });
  };

  const switchDaily = (on: boolean) => {
    setDaily(on);
    void track(updateSettings({ updateCheck: on })).then((result) => {
      if (!result.ok) {
        setDaily(!on);
        toast(result.error);
      }
    });
  };

  return (
    <>
      <SettingsSectionIntro title="About this install">Free and open source. No accounts, no subscriptions.</SettingsSectionIntro>
      <Card padding="none" className="px-7 py-2">
        <dl>
          {facts.map(({ label, value }) => (
            <div key={label} className="flex justify-between gap-4 border-t border-line py-3.5 text-sm first:border-t-0">
              <dt className="text-muted">{label}</dt>
              <dd className="text-right font-mono text-[13px] [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <p className="text-meta text-muted">
        This is jobauto, a personal fork of Dossier for job hunting in Germany, under the same AGPL-3.0 license. Its source is at{" "}
        <a href={FORK_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
          {FORK_REPOSITORY_URL.replace("https://", "")} <span className="sr-only">(opens in a new tab)</span>
        </a>
        ; the project it comes from is{" "}
        <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
          {REPOSITORY_URL.replace("https://", "")} <span className="sr-only">(opens in a new tab)</span>
        </a>
        .
      </p>
      <Card padding="none" className="px-7 py-4">
        <Toggle
          label="Check for updates daily"
          description={
            daily
              ? "Once on each day Dossier is used, the server asks GitHub for the latest release, and the sidebar says when a newer one is out."
              : "Off. Dossier only checks when you press Check for updates."
          }
          checked={daily}
          onCheckedChange={switchDaily}
        />
      </Card>
      <div className="flex flex-wrap items-center gap-3.5">
        <Button variant="secondary" aria-disabled={check.status === "checking" || undefined} onClick={() => check.status !== "checking" && void run()}>
          {check.status === "checking" ? "Checking…" : "Check for updates"}
        </Button>
        <p role="status" className="text-control text-muted">
          {check.status === "latest" && "You're on the latest version."}
          {check.status === "unknown" && "Couldn't check for updates right now."}
          {check.status === "newer" && (
            <>
              Version {check.version} is available.{" "}
              <a href={check.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                See what&apos;s new{" "}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
              {" · "}
              <a href={UPGRADE_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
                How to update{" "}
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </>
          )}
        </p>
      </div>
      <p className="text-meta text-muted">Checking asks GitHub for the latest release and sends nothing about you or this install, daily or when you press it.</p>
    </>
  );
}
