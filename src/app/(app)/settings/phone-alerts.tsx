"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { newTopic, ntfyTarget } from "@/lib/alert-address";

import { saveAlertAddress, testAlert, updateSettings } from "./actions";

export type PhoneAlertSettings = {
  /** The ntfy topic's address; null while alerts are off. */
  address: string | null;
  minScore: number;
  /** Why the last alert didn't go out, if it didn't. */
  problem: string | null;
};

const MIN_SCORES = [60, 65, 70, 75, 80, 85, 90, 95];

/**
 * Phone alerts (alerts.ts), in Settings → Job agent: strong new matches and
 * new jobs on the careers pages she follows, on her phone through ntfy, so
 * she can apply the same day.
 */
export function PhoneAlerts({ initial }: { initial: PhoneAlertSettings }) {
  const track = useTrackSave();
  const [saved, setSaved] = useState(initial.address);
  const [draft, setDraft] = useState(initial.address ?? "");
  const [minScore, setMinScore] = useState(initial.minScore);
  const [problem, setProblem] = useState(initial.problem);
  const [testing, setTesting] = useState(false);
  const typed = draft.trim();
  const invalid = typed !== "" && !ntfyTarget(typed);

  const save = async (address: string | null) => {
    const result = toastResult(await track(saveAlertAddress({ address })));
    if (!result.ok) return;
    setSaved(result.data.address);
    setDraft(result.data.address ?? "");
    setProblem(null);
  };

  const test = async () => {
    setTesting(true);
    const result = toastResult(await testAlert({}));
    setTesting(false);
    if (result.ok) setProblem(null);
  };

  const changeMinScore = (next: number) => {
    const previous = minScore;
    setMinScore(next);
    void track(updateSettings({ alertMinScore: next })).then((result) => {
      if (!toastResult(result).ok) setMinScore(previous);
    });
  };

  return (
    <Card className="flex flex-col gap-4 text-sm text-pretty">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Phone alerts</h3>
        <p className="text-muted">
          A strong new match from the agent, or a new job on a careers page you follow, goes straight to your phone, so you can apply the same day. Install the free ntfy app, add a
          topic there, and paste its address here. Anyone who knows a topic on ntfy.sh can read it, so use one nobody could guess. Only job titles, companies and scores are sent.
        </p>
      </div>
      {problem && (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
          The last alert didn&apos;t go out: {problem}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Topic address"
          className="min-w-0 flex-[1_1_320px]"
          inputClassName="font-mono text-[13.5px]"
          placeholder="https://ntfy.sh/your-topic"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          error={invalid ? "An address such as https://ntfy.sh/your-topic" : undefined}
          onChange={(event) => setDraft(event.target.value)}
        />
        {typed === "" && (
          <Button variant="secondary" onClick={() => setDraft(`https://ntfy.sh/${newTopic()}`)}>
            Make one up
          </Button>
        )}
        {typed !== (saved ?? "") && typed !== "" && (
          <Button variant="secondary" aria-disabled={invalid || undefined} onClick={invalid ? undefined : () => void save(typed)}>
            Save
          </Button>
        )}
        {saved && typed === saved && (
          <>
            <Button variant="secondary" aria-disabled={testing || undefined} onClick={testing ? undefined : () => void test()}>
              {testing ? "Sending…" : "Send a test"}
            </Button>
            <Button variant="text" onClick={() => void save(null)}>
              Turn off
            </Button>
          </>
        )}
      </div>
      <Select
        label="Alert about agent matches scored at least"
        className="max-w-[320px]"
        value={String(minScore)}
        onChange={(event) => changeMinScore(Number(event.target.value))}
      >
        {[...new Set([...MIN_SCORES, minScore])].sort((a, b) => a - b).map((score) => (
          <option key={score} value={score}>
            {score} of 100
          </option>
        ))}
      </Select>
      <p className="text-meta text-muted">{saved ? `On: alerts go to ${saved}.` : "Off. Nothing is sent until a topic is saved."}</p>
    </Card>
  );
}
