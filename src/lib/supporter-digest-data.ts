import "server-only";

import { sendAlert } from "@/lib/alerts";
import { dayOf } from "@/lib/calendar-view";
import { logServerError } from "@/lib/log";
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

/** Sends the digest to the supporter's topic now; that day counts as sent, so the schedule doesn't send it again. */
export async function sendDigest(address: string, now = new Date()): Promise<void> {
  const digest = await buildDigest(now);
  // Marked first: a send that times out after ntfy took it isn't repeated.
  await saveSettings({ supporterSentOn: dayOf(now, await lastKnownTimeZone()) });
  await sendAlert(address, { ...digest, open: "/" });
}

/** Sends the week's digest when it's due; never fails the timer. */
export async function sendDueDigest(now = new Date()): Promise<boolean> {
  const settings = await loadSettings();
  if (!settings.supporterAddress) return false;
  const timeZone = await lastKnownTimeZone();
  if (!digestDue(now, timeZone, { weekday: settings.supporterDay, hour: settings.supporterHour, sentOn: settings.supporterSentOn })) return false;
  try {
    await sendDigest(settings.supporterAddress, now);
    return true;
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
