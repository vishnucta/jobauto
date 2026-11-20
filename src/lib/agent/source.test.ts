import { describe, expect, it, vi } from "vitest";

import type { JobSearchConfig } from "@/lib/job-search/config";

import { agentSourceChoices, agentSourceFor } from "./source";

const keys = vi.hoisted(() => ({ ready: new Set<string>(["FREEHIRE"]) }));
vi.mock("@/lib/job-search/config", async () => {
  const { JobSearchError } = await import("@/lib/job-search/errors");
  return {
    credentialsFor: (_config: unknown, source: string) => {
      if (!keys.ready.has(source)) throw new JobSearchError("no-key", "No key.");
      return {};
    },
  };
});

const config = (source: JobSearchConfig["source"]) => ({ source }) as JobSearchConfig;

describe("the job agent's source", () => {
  it("takes the one chosen for it, or Find jobs' source", () => {
    keys.ready = new Set(["FREEHIRE", "JSEARCH"]);
    expect(agentSourceFor(config("ADZUNA"), "JSEARCH")).toBe("JSEARCH");
    expect(agentSourceFor(config("ADZUNA"), null)).toBe("ADZUNA");
  });

  it("never the Bundesagentur: the first source with a key instead, or none", () => {
    keys.ready = new Set(["FREEHIRE", "ADZUNA", "JOOBLE"]);
    expect(agentSourceFor(config("ARBEITSAGENTUR"), null)).toBe("ADZUNA");
    keys.ready = new Set(["FREEHIRE"]);
    expect(agentSourceFor(config("ARBEITSAGENTUR"), null)).toBeNull();
  });

  it("stays off while job search is off, unless one is chosen", () => {
    keys.ready = new Set(["FREEHIRE", "JSEARCH"]);
    expect(agentSourceFor(config(null), null)).toBeNull();
    expect(agentSourceFor(config(null), "JSEARCH")).toBe("JSEARCH");
  });

  it("offers each source with a key, and FreeHire", () => {
    keys.ready = new Set(["FREEHIRE", "SERPAPI"]);
    expect(agentSourceChoices(config("ARBEITSAGENTUR"))).toEqual(["SERPAPI", "FREEHIRE"]);
  });
});
