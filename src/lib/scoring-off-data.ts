import "server-only";

import { isAiUsable } from "@/lib/ai/config";
import { prisma } from "@/lib/prisma";
import { levelsProblem, listProfiles, profileIdOr } from "@/lib/profiles";
import { scoringOff, type ScoringOffNotice } from "@/lib/scoring-off";

/**
 * Whether scoring is off for the profiles a screen scores against (jobauto
 * fork, scoring-off.ts): every one for Positions, the dashboard and
 * Settings, which score against any of them; the job agent's searches'
 * for the Agent screen, or the first profile while it has none switched on.
 */
export async function loadScoringOff(scope: "all" | "agent" = "all"): Promise<ScoringOffNotice | null> {
  const profiles = await listProfiles();
  const ids = scope === "agent" ? await agentProfileIds(profiles.map((profile) => profile.id)) : profiles.map((profile) => profile.id);
  // The same check scoring makes before it scores (E24-3), so the notice shows exactly when scoring would wait.
  const off = scoringOff(await Promise.all(ids.map((id) => levelsProblem(id))), profiles.length);
  return off && { ...off, canGuess: await isAiUsable() };
}

/** The profiles the job agent's switched-on searches score against, as its run picks them (agent/run.ts). */
async function agentProfileIds(all: string[]): Promise<string[]> {
  const searches = await prisma.agentSearch.findMany({ where: { enabled: true }, select: { profileId: true, allProfiles: true } });
  if (searches.some((search) => search.allProfiles)) return all;
  const ids = await Promise.all((searches.length > 0 ? searches : [{ profileId: null }]).map((search) => profileIdOr(search.profileId)));
  return all.filter((id) => ids.includes(id));
}
