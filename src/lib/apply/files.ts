import "server-only";

import { rm } from "node:fs/promises";
import path from "node:path";

import { env } from "@/lib/env";

import { closeApplyBrowser } from "./browser";
import { stopWatching, stopWatchingAll } from "./watches";

// What the apply assistant keeps in the data directory (Phase A): a folder
// per run under apply/, with the PDFs it attached and its screenshots, and
// the browser window's profile in apply-browser/, which holds the user's
// sign-ins to job sites. Both go with what they belong to: a run's folder
// with its application, all of it with Delete everything.

/** Where a run's PDFs and screenshots are kept. */
export const applyDir = (attemptId: string) => path.join(env.DOSSIER_DATA_DIR, "apply", attemptId);

/** The browser's own profile, kept between runs. */
export const applyProfileDir = () => path.join(env.DOSSIER_DATA_DIR, "apply-browser");

export const SCREENSHOTS = { filled: "filled.png", confirmation: "confirmation.png" } as const;

// Chrome can hold on to its profile's files for a moment after it closes.
const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const;

/** Deletes runs' folders once their application is gone; their pages are no longer watched. */
export async function deleteApplyRuns(attemptIds: readonly string[]): Promise<void> {
  for (const attemptId of attemptIds) stopWatching(attemptId);
  await Promise.all(attemptIds.map((attemptId) => rm(applyDir(attemptId), REMOVE)));
}

/** Delete everything: closes the browser window, then removes every run's folder and the profile with its sign-ins. */
export async function deleteAllApplyData(): Promise<void> {
  stopWatchingAll();
  await closeApplyBrowser();
  await Promise.all([rm(path.join(env.DOSSIER_DATA_DIR, "apply"), REMOVE), rm(applyProfileDir(), REMOVE)]);
}
