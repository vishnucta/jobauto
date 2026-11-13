"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { applyAnswersSchema } from "@/lib/apply/answers";
import { closeApplyBrowser } from "@/lib/apply/browser";
import { browserAddressSchema } from "@/lib/apply/browser-address";
import { resolveAttempt } from "@/lib/apply/run";
import { startApplyRun, startFillPage } from "@/lib/apply/start";
import { prisma } from "@/lib/prisma";
import { saveSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";

// The Apply tab's actions (Phase A): start a run in the browser, save the
// standard answers and where the browser window opens, and settle a run by
// the user's word.

const refresh = (id: string) => revalidatePath(`/applications/${id}`);

/**
 * "Open and fill it in": starts the apply assistant for an application and
 * returns the job to follow (src/lib/apply/start.ts). A run started here
 * may press Send where the standard answers allow it.
 */
export const startApply = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const started = await startApplyRun(id, { mayPressSend: true });
  if (!started.ok) throw new ActionError(started.message);
  if (!started.alreadyRunning) refresh(id);
  return { jobId: started.jobId, attemptId: started.attemptId };
});

/**
 * "Fill this page": fills the page the user is looking at, in the window of the run
 * that is waiting for her, and returns the job to follow (src/lib/apply/start.ts).
 * She has got past a login, a bot check or a step of the form herself; Send stays hers.
 */
export const fillThisPage = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const started = await startFillPage(id);
  if (!started.ok) throw new ActionError(started.message);
  if (!started.alreadyRunning) refresh(id);
  return { jobId: started.jobId, attemptId: started.attemptId };
});

/** The standard answers on the Apply tab, saved for every application. */
export const saveApplyAnswers = action(z.object({ id: z.string().min(1), answers: applyAnswersSchema }), async ({ id, answers }, { toast }) => {
  await saveSettings({ applyAnswers: answers });
  refresh(id);
  toast("Saved. I'll use these answers on every form.");
  return null;
});

/**
 * Browser window: the laptop's Chrome the window opens in when the app runs on
 * a server, or none (an empty address) for a window on the computer the app
 * runs on. A window already open is let go, so the next run uses the new one.
 */
export const saveApplyBrowser = action(
  z.object({ id: z.string().min(1), address: z.union([z.literal(""), browserAddressSchema]) }),
  async ({ id, address }, { toast }) => {
    await saveSettings({ applyBrowserAddress: address || null });
    await closeApplyBrowser();
    refresh(id);
    toast(address ? `Saved. The window will open in the Chrome at ${address}.` : "Saved. The window will open on the computer the app runs on.");
    return null;
  },
);

/** How long "Test" waits for the laptop's Chrome. */
const TEST_TIMEOUT_MS = 5_000;

/** "Test": whether the laptop's Chrome answers at the address, before a run depends on it. Nothing is opened. */
export const testApplyBrowser = action(z.object({ address: browserAddressSchema }), async ({ address }) => {
  try {
    const response = await fetch(`${address}/json/version`, { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { Browser: version } = (await response.json()) as { Browser?: string };
    return { version: version ?? "Chrome" };
  } catch {
    throw new ActionError(`Nothing answered at ${address}. Start Chrome with the Apply shortcut on the laptop, and check that Tailscale is on there.`);
  }
});

/** "I sent it" / "I didn't send it": settles a run the page couldn't read the end of. */
export const settleApplyAttempt = action(z.object({ attemptId: z.string().min(1), sent: z.boolean() }), async ({ attemptId, sent }, { toast }) => {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId }, select: { applicationId: true } });
  if (!attempt) throw new ActionError("That run no longer exists.");
  const settled = await resolveAttempt(attemptId, sent);
  refresh(attempt.applicationId);
  // It ended since the tab was loaded, e.g. the page confirmed it: it keeps how it ended.
  if (!settled) throw new ActionError("That run already ended.");
  toast(sent ? `Marked as sent. ${statusInfo(ApplicationStatus.SENT).toast}` : "Noted: nothing was sent.");
  return null;
});
