import "server-only";

import { hasPortalKey, portalsLeftOff, type PortalView } from "@/lib/job-search/sources";
import { loadSettings, saveSettings } from "@/lib/settings-data";

/**
 * The one-time note after the 1.15 upgrade (jobauto fork): the portals with
 * their key that are switched off (sources.ts portalsLeftOff), on Positions
 * and Settings → Job search, or null once it's done. It's done when it's
 * dismissed, and for good the first time a portal with its key is on, so
 * switching it off again later doesn't bring the note back. Nothing here
 * switches a portal on.
 */
export async function portalsOffNote(portals: readonly PortalView[]): Promise<string[] | null> {
  if ((await loadSettings()).portalsOffNoteDone) return null;
  const names = portalsLeftOff(portals);
  if (!names && portals.some((portal) => hasPortalKey(portal) && portal.on)) await saveSettings({ portalsOffNoteDone: true });
  return names;
}
