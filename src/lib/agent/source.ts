import { JobSearchError } from "@/lib/job-search/errors";
import { credentialsFor, enabledPortals, type JobSearchConfig } from "@/lib/job-search/config";
import type { JobSource } from "@/lib/job-search/search";
import { sourceInfo } from "@/lib/job-search/sources";

// The job agent's own portals (jobauto fork). Positions may search the
// Bundesagentur, which the agent may not (it searches on its own, which the
// BA's terms forbid most clearly, #223), and she may want the agent's three
// requests a day per portal spent elsewhere than her own searches. So the
// agent can have portals of its own (Settings → Job agent, "Searches with"),
// switched on in Settings → Job search or not. Left on Automatic (null), it
// asks every portal switched on there (E22-8), or, when that's only the
// Bundesagentur, the first portal with a key saved, so a key she already has
// keeps it running.

/** Whether the agent may ever ask a portal: never the Bundesagentur für Arbeit (#223). */
export const agentMayAsk = (id: string) => id !== "ARBEITSAGENTUR";

/** Tried in this order on Automatic, when only the Bundesagentur is switched on: the portals with a key. */
const FALLBACK: readonly JobSource[] = ["JSEARCH", "SERPAPI", "ADZUNA", "JOOBLE"];

/** Why a portal can't be asked (a key missing, paused, not offered), or null. */
export function portalProblem(config: JobSearchConfig, id: JobSource): string | null {
  try {
    credentialsFor(config, id);
    return null;
  } catch (error) {
    if (error instanceof JobSearchError) return error.message;
    throw error;
  }
}

/**
 * The portals the agent goes to, in Settings order, before their keys are
 * checked: those chosen for it, or on Automatic those switched on in
 * Settings → Job search; when that's only the Bundesagentur, the first
 * portal with a key. None while every portal is off and none is chosen.
 */
export function agentPortalPool(config: JobSearchConfig, chosen: readonly string[] | null): JobSource[] {
  if (chosen) return config.portals.filter((portal) => chosen.includes(portal.id) && agentMayAsk(portal.id)).map((portal) => portal.id);
  const enabled = enabledPortals(config);
  const allowed = enabled.filter(agentMayAsk);
  // Job search switched off keeps the agent off too.
  if (allowed.length > 0 || enabled.length === 0) return allowed;
  const fallback = FALLBACK.find((id) => portalProblem(config, id) === null);
  return fallback ? [fallback] : [];
}

/** The portals the agent asks: its pool, with what each needs saved. */
export function agentPortals(config: JobSearchConfig, chosen: readonly string[] | null): JobSource[] {
  return agentPortalPool(config, chosen).filter((id) => portalProblem(config, id) === null);
}

/** The portals she could choose for the agent: each that can be asked, switched on in Job search or not, never the Bundesagentur. */
export function agentPortalChoices(config: JobSearchConfig): JobSource[] {
  return config.portals.filter((portal) => agentMayAsk(portal.id) && portalProblem(config, portal.id) === null).map((portal) => portal.id);
}

/** What Settings → Job agent shows of it (what's chosen is in its settings): what Automatic asks, and the choices, named. */
export type AgentPortalsView = {
  automatic: string[];
  choices: { id: string; name: string }[];
};

export function agentPortalsView(config: JobSearchConfig, chosen: readonly string[] | null): AgentPortalsView {
  const choices = agentPortalChoices(config);
  // A chosen portal that can't be asked now (its key removed) stays listed, so she can untick it.
  const listed = [...choices, ...(chosen ?? []).filter((id) => agentMayAsk(id) && !choices.includes(id))];
  return {
    automatic: agentPortals(config, null),
    choices: listed.map((id) => ({ id, name: sourceInfo(id).name })),
  };
}
