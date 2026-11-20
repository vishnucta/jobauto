import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import type { SearchQuery } from "@/lib/job-search/search";
import { saveSettings } from "@/lib/settings-data";

import { agentSearchSetupProblem, type SavedAgentSearch } from "./search";
import { AGENT_SOURCES } from "./source";
import { listAgentSearches, saveAgentSearch } from "./searches";

// Settings → Job agent (E16-7), from the screen or from Claude: each change
// saves at once. The agent keeps up to three searches (./searches), which the
// screen edits on their own; Claude's one search is the first of them.

/** What may change, any part on its own. Search edits use ./searches. */
export const agentSettingsChangeSchema = z
  .object({
    enabled: z.boolean().optional(),
    hour: z.number().int().min(0).max(23).optional(),
    minScore: z.number().int().min(0).max(100).optional(),
    maxScores: z.number().int().min(1).max(30).optional(),
    maxDrafts: z.number().int().min(0).max(10).optional(),
    autoDraft: z.boolean().optional(),
    /** The agent's own source; null is Automatic (source.ts). */
    source: z.enum(AGENT_SOURCES).nullable().optional(),
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
    const firstAfter: SavedAgentSearch | null = query ? { ...(first ?? { id: "", name: FIRST_SEARCH_NAME, enabled: true, sort: 0, createdAt: now, updatedAt: now }), query } : null;
    const problem = agentSearchSetupProblem(firstAfter ? [firstAfter, ...searches.slice(1)] : searches);
    if (problem) throw new ActionError(problem);
  }
  if (query) {
    if (first) await saveAgentSearch({ name: first.name, query, enabled: first.enabled, sort: first.sort }, first.id);
    else await saveAgentSearch({ name: FIRST_SEARCH_NAME, query });
  }
  await saveSettings({
    agentEnabled: changes.enabled,
    agentHour: changes.hour,
    agentMinScore: changes.minScore,
    agentMaxScores: changes.maxScores,
    agentMaxDrafts: changes.maxDrafts,
    agentAutoDraft: changes.autoDraft,
    agentSource: changes.source,
  });
}
