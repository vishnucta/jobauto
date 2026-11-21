import "server-only";

import { ntfyTarget } from "@/lib/ntfy-address";
import { saveChannel } from "@/lib/notifications/store";
import { loadSettings, saveSettings } from "@/lib/settings-data";

// The fork's phone alerts (jobauto) went to one ntfy topic's address:
// "https://ntfy.sh/jobauto-k3x9…", or a topic on the user's own ntfy server.
// Notifications (E26) replaced them; a saved address moves into an ntfy
// channel once, at start (instrumentation.ts).

// The address itself is read in ntfy-address.ts, which the browser can use too.
export { ntfyTarget };

/**
 * Moves the phone alerts' topic into Settings → Notifications as an ntfy
 * channel named "Phone", with each event at its default (strong new matches
 * and new jobs on careers pages among them), then forgets the old setting.
 * Nothing when no topic is saved. Says whether a channel was added.
 */
export async function moveAlertAddress(): Promise<boolean> {
  const { alertAddress } = await loadSettings();
  if (!alertAddress) return false;
  const target = ntfyTarget(alertAddress);
  if (target) await saveChannel({ type: "NTFY", name: "Phone", config: target, secret: { action: "keep" } });
  await saveSettings({ alertAddress: null });
  return target !== null;
}
