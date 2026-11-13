import "server-only";

import { env } from "@/lib/env";
import { logServerError } from "@/lib/log";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { ntfyTarget } from "./alert-address";

// Phone alerts: a strong new match, or new jobs on a careers page, sent to
// an ntfy topic (ntfy.sh, or the user's own ntfy server) the ntfy app on the
// phone subscribes to. Applying the same day gets far more replies than a
// week later. Only titles, companies and scores go out, never the profile.

export class AlertError extends Error {}

export type Alert = {
  title: string;
  message: string;
  /** A screen in Dossier the alert opens, e.g. "/agent". */
  open?: string;
};

/**
 * Sends one alert to the topic at `address`. Published as JSON to the
 * server's root, so umlauts in a title arrive as written (headers can't
 * carry them).
 */
export async function sendAlert(address: string, alert: Alert): Promise<void> {
  const target = ntfyTarget(address);
  if (!target) throw new AlertError("That isn't an ntfy topic address, such as https://ntfy.sh/your-topic.");
  const click = alert.open && env.DOSSIER_PUBLIC_URL ? `${env.DOSSIER_PUBLIC_URL}${alert.open}` : undefined;
  let response: Response;
  try {
    response = await fetch(target.server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: target.topic, title: alert.title.slice(0, 200), message: alert.message.slice(0, 3000), click, tags: ["briefcase"] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AlertError(`${new URL(target.server).host} couldn't be reached.`);
  }
  if (!response.ok) throw new AlertError(`${new URL(target.server).host} answered ${response.status}${response.status === 403 || response.status === 401 ? ": the topic needs a login" : ""}.`);
}

/**
 * Sends an alert when they're on, without ever failing the work that found
 * it: a problem is kept for Settings → Job agent instead, and cleared once
 * one goes out again.
 */
export async function alertIfOn(alert: Alert): Promise<void> {
  const { alertAddress, alertProblem } = await loadSettings();
  if (!alertAddress) return;
  try {
    await sendAlert(alertAddress, alert);
    if (alertProblem) await saveSettings({ alertProblem: null });
  } catch (error) {
    if (!(error instanceof AlertError)) logServerError("phone alert", error);
    await saveSettings({ alertProblem: error instanceof AlertError ? error.message : "The alert couldn't be sent." });
  }
}

/** One line per posting, best first, for an alert: "88 · Regulatory Reporting Analyst, Acme". */
export function matchLines(postings: readonly { title: string; company: string; score?: number }[], most = 5): string {
  const lines = postings.slice(0, most).map((posting) => [posting.score === undefined ? "" : `${posting.score} ·`, [posting.title, posting.company].filter(Boolean).join(", ")].filter(Boolean).join(" "));
  if (postings.length > most) lines.push(`and ${postings.length - most} more`);
  return lines.join("\n");
}
