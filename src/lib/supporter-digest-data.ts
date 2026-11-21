import "server-only";

import { dayOf } from "@/lib/calendar-view";
import { logServerError } from "@/lib/log";
import { onlyEvent } from "@/lib/notifications/events";
import { anyChannelFor, emit } from "@/lib/notifications/notify";
import { saveChannel } from "@/lib/notifications/store";
import { ntfyTarget } from "@/lib/ntfy-address";
import { prisma } from "@/lib/prisma";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { digestDue, supporterDigest, type Digest } from "./supporter-digest";

/** The digest as of now, from every application but the job agent's unreviewed drafts. */
export async function buildDigest(now = new Date()): Promise<Digest> {
  const [settings, timeZone, applications] = await Promise.all([
    loadSettings(),
    lastKnownTimeZone(),
    prisma.application.findMany({
      where: { awaitingReview: false, archivedAt: null },
      select: { company: true, role: true, title: true, status: true, sentAt: true, nextInterviewAt: true, createdAt: true, events: { select: { to: true, at: true }, orderBy: { at: "asc" } } },
    }),
  ]);
  return supporterDigest(
    applications.map((application) => ({
      company: application.company,
      role: application.role || application.title,
      status: application.status,
      sentAt: application.sentAt,
      nextInterviewAt: application.nextInterviewAt,
      lastChange: application.events.at(-1)?.at ?? application.createdAt,
      moves: application.events,
    })),
    { target: settings.weeklyTarget, quietDays: settings.quietDays, now, timeZone },
  );
}

/**
 * The fork's supporter digest went to an ntfy topic of the supporter's own,
 * saved in Settings → Job agent (supporterAddress). Notifications delivers
 * it now (jobauto fork): a saved topic becomes an ntfy channel named
 * "Supporter" with only the digest on, so they still get the digest and
 * nothing else, and the old setting is cleared once the channel exists. The
 * day and hour stay where they were (supporterDay, supporterHour). Nothing
 * when no topic is saved; one that isn't an ntfy address is left as it was.
 * Says whether a channel was added.
 */
export async function moveSupporterAddress(): Promise<boolean> {
  const { supporterAddress } = await loadSettings();
  if (!supporterAddress) return false;
  const target = ntfyTarget(supporterAddress);
  if (!target) return false;
  await saveChannel({ type: "NTFY", name: "Supporter", config: target, secret: { action: "keep" }, events: onlyEvent("supporter.digest") });
  await saveSettings({ supporterAddress: null });
  return true;
}

/**
 * The week's digest, now, as a Notifications event: it goes to the channels
 * that have it on, the supporter's. That day counts as sent, so the schedule
 * doesn't send it again. Returns how many channels it went to.
 */
export async function sendDigest(now = new Date()): Promise<number> {
  const digest = await buildDigest(now);
  // Marked first: a send that times out after ntfy took it isn't repeated.
  await saveSettings({ supporterSentOn: dayOf(now, await lastKnownTimeZone()) });
  return emit("supporter.digest", { title: digest.title.slice(0, 200), message: digest.message.slice(0, 3000) }, now);
}

/** Sends the week's digest when it's due and a channel has it on; never fails the timer. */
export async function sendDueDigest(now = new Date()): Promise<boolean> {
  try {
    await moveSupporterAddress();
    if (!(await anyChannelFor("supporter.digest"))) return false;
    const settings = await loadSettings();
    const timeZone = await lastKnownTimeZone();
    if (!digestDue(now, timeZone, { weekday: settings.supporterDay, hour: settings.supporterHour, sentOn: settings.supporterSentOn })) return false;
    return (await sendDigest(now)) > 0;
  } catch (error) {
    logServerError("supporter digest", error);
    return false;
  }
}

const EVERY_MS = 30 * 60 * 1000;
const globalForDigest = globalThis as unknown as { digestTimer?: ReturnType<typeof setInterval> };

/** Starts the timer, once per process (dev reloads keep the one they have). */
export function startDigestSchedule(): void {
  if (globalForDigest.digestTimer) return;
  const check = () => void sendDueDigest().catch((error: unknown) => logServerError("supporter digest schedule", error));
  globalForDigest.digestTimer = setInterval(check, EVERY_MS);
  globalForDigest.digestTimer.unref?.();
  check();
}
