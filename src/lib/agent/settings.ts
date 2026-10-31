import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { searchQuerySchema } from "@/lib/job-search/search";
import { loadSettings, saveSettings } from "@/lib/settings-data";

import { agentQueryReady } from "./run";

// Settings → Job agent (E16-7), from the screen or from Claude: each change
// saves at once.

/** What may change, any part on its own. */
export const agentSettingsChangeSchema = z.object({
  enabled: z.boolean().optional(),
  query: searchQuerySchema.optional(),
  hour: z.number().int().min(0).max(23).optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  maxScores: z.number().int().min(1).max(30).optional(),
  maxDrafts: z.number().int().min(0).max(10).optional(),
  autoDraft: z.boolean().optional(),
});
export type AgentSettingsChange = z.output<typeof agentSettingsChangeSchema>;

/** Saves the changes. Turning the agent on needs a search with keywords and a country. */
export async function updateAgentSettings(changes: AgentSettingsChange): Promise<void> {
  const settings = await loadSettings();
  const query = changes.query ?? settings.agentQuery;
  if (changes.enabled && !agentQueryReady(query)) {
    throw new ActionError(query.keywords.trim() ? "Choose a country for the search before turning the agent on." : "Type what the agent should look for before turning it on.");
  }
  await saveSettings({
    agentEnabled: changes.enabled,
    agentQuery: changes.query,
    agentHour: changes.hour,
    agentMinScore: changes.minScore,
    agentMaxScores: changes.maxScores,
    agentMaxDrafts: changes.maxDrafts,
    agentAutoDraft: changes.autoDraft,
  });
}
