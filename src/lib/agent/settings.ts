import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import type { SearchQuery } from "@/lib/job-search/search";
import { COVERS, coversFromScore, type Covers } from "@/lib/posting-coverage";
import { saveSettings } from "@/lib/settings-data";

import { agentSearchSetupProblem, type SavedAgentSearch } from "./search";
import { listAgentSearches, saveAgentSearch } from "./searches";

// Settings → Job agent (E16-7), from the screen or from Claude: each change
// saves at once. The agent keeps up to three searches (./searches), which the
// screen edits on their own; Claude's one search is the first of them.

/** What may change, any part on its own. Search edits use ./searches. */
export const agentSettingsChangeSchema = z
  .object({
    enabled: z.boolean().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    /** The queue's cut-off (E32-2). */
    covers: z.enum(COVERS).optional(),
    /** A 0-100 minimum, as Claude may still give it: saved as the cut-off it maps to (E32-2). */
    minScore: z.number().int().min(0).max(100).optional(),
    maxScores: z.number().int().min(1).max(30).optional(),
    maxDrafts: z.number().int().min(0).max(10).optional(),
    autoDraft: z.boolean().optional(),
    /** Which new matches get a Strong new matches message (jobauto fork). */
    strongCovers: z.enum(COVERS).optional(),
  })
  .strict();
export type AgentSettingsChange = z.output<typeof agentSettingsChangeSchema> & {
  /**
   * From Claude (bewerbung fork): "the agent's search", which is the first
   * search; "My search" is made when there is none. Its name, order and
   * whether it's on stay as they are.
   */
  query?: SearchQuery;
};

/**
 * The strong-match cut-off is kept as the fork's 0-100 alert minimum
 * (alertMinScore), which coversFromScore reads back: each cut-off is saved as
 * the lowest minimum that gives it.
 */
const STRONG_MINIMUM: Record<Covers, number> = { any: 0, half: 50, "two-thirds": 70, all: 90 };

/** The name a first search gets, as the upgrade gives the old one. */
const FIRST_SEARCH_NAME = "My search";

/**
 * Saves the changes. Turning the agent on needs an enabled search with
 * keywords and a country; nothing is saved when it can't be turned on.
 */
export async function updateAgentSettings({ query, ...changes }: AgentSettingsChange): Promise<void> {
  const searches = await listAgentSearches();
  const [first] = searches;
  if (query) {
    if (!query.keywords.trim()) throw new ActionError("Add what to look for.");
    if ((first?.enabled ?? true) && !query.country) throw new ActionError(`Choose a country for “${first?.name ?? FIRST_SEARCH_NAME}”.`);
  }
  if (changes.enabled) {
    // The searches as they will be once the query is saved.
    const now = new Date();
    const firstAfter: SavedAgentSearch | null = query
      ? { ...(first ?? { id: "", name: FIRST_SEARCH_NAME, enabled: true, sort: 0, profileId: null, allProfiles: false, createdAt: now, updatedAt: now }), query }
      : null;
    const problem = agentSearchSetupProblem(firstAfter ? [firstAfter, ...searches.slice(1)] : searches);
    if (problem) throw new ActionError(problem);
  }
  if (query) {
    // Its profile (E24-6, E25-5) stays as it is too.
    if (first) await saveAgentSearch({ name: first.name, query, enabled: first.enabled, sort: first.sort, profileId: first.profileId, allProfiles: first.allProfiles }, first.id);
    else await saveAgentSearch({ name: FIRST_SEARCH_NAME, query });
  }
  await saveSettings({
    agentEnabled: changes.enabled,
    agentHour: changes.hour,
    agentCovers: changes.covers ?? (changes.minScore === undefined ? undefined : coversFromScore(changes.minScore)),
    agentMaxScores: changes.maxScores,
    agentMaxDrafts: changes.maxDrafts,
    agentAutoDraft: changes.autoDraft,
    alertMinScore: changes.strongCovers === undefined ? undefined : STRONG_MINIMUM[changes.strongCovers],
  });
}
