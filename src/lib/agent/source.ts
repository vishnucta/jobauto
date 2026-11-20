import { JobSearchError } from "@/lib/job-search/errors";
import { credentialsFor, type JobSearchConfig } from "@/lib/job-search/config";
import { JOB_SOURCES, type JobSource } from "@/lib/job-search/search";

// The job agent's own source (jobauto fork). Find jobs may search the
// Bundesagentur, which the agent may not (it searches on its own, which the
// BA's terms forbid most clearly, #223). So the agent can have a source of
// its own; left on Automatic, it takes Find jobs' source, or else the first
// source with a key saved, so a key she already has keeps it running.

/** The sources the agent may search. */
export const AGENT_SOURCES = JOB_SOURCES.filter((source) => source !== "ARBEITSAGENTUR") as Exclude<JobSource, "ARBEITSAGENTUR">[];
export type AgentSource = (typeof AGENT_SOURCES)[number];

/** Tried in this order on Automatic, when Find jobs' source can't be used: those with a key first. */
const FALLBACK: readonly AgentSource[] = ["JSEARCH", "SERPAPI", "ADZUNA", "JOOBLE"];

/** Whether the source has what it needs (its key) in this configuration. */
export function sourceReady(config: JobSearchConfig, source: JobSource): boolean {
  try {
    credentialsFor(config, source);
    return true;
  } catch (error) {
    if (error instanceof JobSearchError) return false;
    throw error;
  }
}

/** The sources she could choose for the agent: each that's ready, and FreeHire, which needs no key. */
export function agentSourceChoices(config: JobSearchConfig): AgentSource[] {
  return AGENT_SOURCES.filter((source) => source === "FREEHIRE" || sourceReady(config, source));
}

/**
 * The source the agent searches: the one chosen for it; on Automatic (null),
 * Find jobs' source, or, when that's the Bundesagentur, the first with a key.
 * Null when there's none, or job search is off.
 */
export function agentSourceFor(config: JobSearchConfig, chosen: AgentSource | null): AgentSource | null {
  if (chosen) return chosen;
  // Job search switched off keeps the agent off too.
  if (!config.source) return null;
  if (config.source !== "ARBEITSAGENTUR") return config.source;
  return FALLBACK.find((source) => sourceReady(config, source)) ?? null;
}
