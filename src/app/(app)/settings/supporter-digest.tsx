"use client";

import { useState } from "react";

import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { ChannelView, DeliveryView } from "@/lib/notifications/channels";
import { newTopic, ntfyTarget } from "@/lib/ntfy-address";

import { updateSettings } from "./actions";
import { addSupporterChannel, sendDigestNow } from "./notifications-actions";

export type SupporterDigestSettings = {
  /** 1 = Monday … 7 = Sunday. */
  day: number;
  hour: number;
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * The supporter digest (jobauto fork), in Settings → Notifications: a weekly
 * summary of her search on the phone of whoever supports it: what went out,
 * what moved on, interviews coming, follow-ups due, and where help matters
 * most. It's the "Weekly digest for a supporter" event; their ntfy topic is
 * a channel of its own with only that event on, so they get the digest and
 * nothing else. The day and hour are set here.
 */
export function SupporterDigest({
  initial,
  channels,
  onAdded,
  onLog,
}: {
  initial: SupporterDigestSettings;
  channels: ChannelView[];
  onAdded: (channel: ChannelView) => void;
  onLog: (log: DeliveryView[]) => void;
}) {
  const track = useTrackSave();
  const [draft, setDraft] = useState("");
  const [when, setWhen] = useState(initial);
  const [sending, setSending] = useState(false);
  const typed = draft.trim();
  const invalid = typed !== "" && !ntfyTarget(typed);
  const receivers = channels.filter((channel) => channel.events["supporter.digest"]);

  const add = async () => {
    const result = toastResult(await track(addSupporterChannel({ address: typed })));
    if (!result.ok) return;
    onAdded(result.data);
    setDraft("");
  };

  const change = (next: Partial<SupporterDigestSettings>) => {
    const previous = when;
    setWhen({ ...when, ...next });
    void track(updateSettings({ ...(next.day ? { supporterDay: next.day } : {}), ...(next.hour !== undefined ? { supporterHour: next.hour } : {}) })).then((result) => {
      if (!toastResult(result).ok) setWhen(previous);
    });
  };

  const send = async () => {
    setSending(true);
    const result = toastResult(await sendDigestNow({}));
    setSending(false);
    if (result.ok) onLog(result.data);
  };

  return (
    <section aria-labelledby="supporter-heading" className="flex flex-col gap-3">
      <h3 id="supporter-heading" className="text-field font-medium">
        Weekly digest for a supporter
      </h3>
      <Card className="flex flex-col gap-4 text-sm text-pretty">
        <p className="text-muted">
          Once a week, a short summary of the search on the phone of whoever supports it: what went out, what moved on, interviews coming, follow-ups due, and where their help
          matters most that week. They install the ntfy app and subscribe to a topic of their own; it becomes a channel here that gets the digest and nothing else. Company names
          and interview times are in it.
        </p>
        {receivers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-[1_1_320px]">
              On: it goes to {receivers.map((channel) => `${channel.name} (${channel.summary})`).join(", ")}. To stop it, switch it off for that channel in the grid, or remove the
              channel.
            </p>
            <Button variant="secondary" aria-disabled={sending || undefined} onClick={sending ? undefined : () => void send()}>
              {sending ? "Sending…" : "Send this week's now"}
            </Button>
          </div>
        ) : (
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
            {typed === "" ? (
              <Button variant="secondary" onClick={() => setDraft(`https://ntfy.sh/${newTopic()}`)}>
                Make one up
              </Button>
            ) : (
              <Button variant="secondary" aria-disabled={invalid || undefined} onClick={invalid ? undefined : () => void add()}>
                Add their channel
              </Button>
            )}
          </div>
        )}
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
        {receivers.length === 0 && <p className="text-meta text-muted">Off. Nothing is sent until a channel gets it.</p>}
      </Card>
    </section>
  );
}
