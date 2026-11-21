"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { closeApplyBrowser } from "@/lib/apply/browser";
import { browserAddressSchema } from "@/lib/apply/browser-address";
import { saveSettings } from "@/lib/settings-data";

// Where the apply assistant's browser window opens (jobauto fork): set up
// once in Settings → Standard answers, beside the assistant's other
// settings, not on every application's Apply tab (audit round 2).

/**
 * The laptop's Chrome the window opens in when the app runs on a server,
 * or none (an empty address) for a window on the computer the app runs on.
 * A window already open is let go, so the next run uses the new one.
 */
export const saveApplyBrowser = action(z.object({ address: z.union([z.literal(""), browserAddressSchema]) }), async ({ address }, { toast }) => {
  await saveSettings({ applyBrowserAddress: address || null });
  await closeApplyBrowser();
  // Every Apply tab says where the window opens.
  revalidatePath("/settings");
  revalidatePath("/applications", "layout");
  toast(address ? `Saved. The window will open in the Chrome at ${address}.` : "Saved. The window will open on the computer the app runs on.");
  return null;
});

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
