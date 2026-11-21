"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { newTopic, ntfyTarget } from "@/lib/ntfy-address";

import { saveSupporterAddress, sendDigestNow, updateSettings } from "./actions";

export type SupporterDigestSettings = {
  /** The supporter's own ntfy topic; null while the digest is off. */
  address: string | null;
  /** 1 = Monday … 7 = Sunday. */
  day: number;
  hour: number;
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * The supporter digest (jobauto fork), in Settings → Job agent: a weekly
 * summary of her search on the phone of whoever supports it, through their
 * own ntfy topic: what went out, what moved on, interviews coming,
 * follow-ups due, and where help matters most. The topic is theirs alone,
 * not one of her Notifications channels, so they get the digest and nothing
 * else.
 */
export function SupporterDigest({ initial }: { initial: SupporterDigestSettings }) {
  const track = useTrackSave();
  const [saved, setSaved] = useState(initial.address);
  const [draft, setDraft] = useState(initial.address ?? "");
  const [when, setWhen] = useState({ day: initial.day, hour: initial.hour });
  const [sending, setSending] = useState(false);
  const typed = draft.trim();
  const invalid = typed !== "" && !ntfyTarget(typed);

  const save = async (address: string | null) => {
    const result = toastResult(await track(saveSupporterAddress({ address })));
    if (!result.ok) return;
    setSaved(result.data.address);
    setDraft(result.data.address ?? "");
  };

  const change = (next: Partial<typeof when>) => {
    const previous = when;
    setWhen({ ...when, ...next });
    void track(updateSettings({ ...(next.day ? { supporterDay: next.day } : {}), ...(next.hour !== undefined ? { supporterHour: next.hour } : {}) })).then((result) => {
      if (!toastResult(result).ok) setWhen(previous);
    });
  };

  const send = async () => {
    setSending(true);
    toastResult(await sendDigestNow({}));
    setSending(false);
  };

  return (
    <Card className="flex flex-col gap-4 text-sm text-pretty">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">Weekly digest for a supporter</h3>
        <p className="text-muted">
          Once a week, a short summary of the search on the phone of whoever supports it: what went out, what moved on, interviews coming, follow-ups due, and where their help
          matters most that week. They install the ntfy app and subscribe to a topic of their own; paste its address here. Company names and interview times are in it.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Their topic address"
          className="min-w-0 flex-[1_1_320px]"
          inputClassName="font-mono text-[13.5px]"
          placeholder="https://ntfy.sh/their-topic"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          error={invalid ? "An address such as https://ntfy.sh/their-topic" : undefined}
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
            <Button variant="secondary" aria-disabled={sending || undefined} onClick={sending ? undefined : () => void send()}>
              {sending ? "Sending…" : "Send this week's now"}
            </Button>
            <Button variant="text" onClick={() => void save(null)}>
              Turn off
            </Button>
          </>
        )}
      </div>
      <div className="grid max-w-[480px] gap-3 sm:grid-cols-2">
        <Select label="Every" value={String(when.day)} onChange={(event) => change({ day: Number(event.target.value) })}>
          {DAYS.map((name, index) => (
            <option key={name} value={index + 1}>
              {name}
            </option>
          ))}
        </Select>
        <Select label="From" value={String(when.hour)} onChange={(event) => change({ hour: Number(event.target.value) })}>
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {String(hour).padStart(2, "0")}:00
            </option>
          ))}
        </Select>
      </div>
      <p className="text-meta text-muted">{saved ? `On: it goes to ${saved}.` : "Off. Nothing is sent until a topic is saved."}</p>
    </Card>
  );
}
