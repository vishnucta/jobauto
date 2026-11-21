import { describe, expect, it, vi } from "vitest";

import type { JobSearchConfig } from "@/lib/job-search/config";

import { agentPortalChoices, agentPortals, agentPortalsView } from "./source";

const keys = vi.hoisted(() => ({ ready: new Set<string>(["FREEHIRE"]) }));
vi.mock("@/lib/job-search/config", async () => {
  const { JobSearchError } = await import("@/lib/job-search/errors");
  return {
    enabledPortals: (config: JobSearchConfig) => config.portals.filter((portal) => portal.on).map((portal) => portal.id),
    credentialsFor: (_config: unknown, source: string) => {
      if (!keys.ready.has(source)) throw new JobSearchError("no-key", "No key.");
      return {};
    },
  };
});

const ALL = ["JSEARCH", "SERPAPI", "ADZUNA", "FREEHIRE", "ARBEITSAGENTUR"];
/** Every built-in, in Settings order, with those given switched on in Settings → Job search. */
const config = (...on: string[]) => ({ portals: ALL.map((id) => ({ id, on: on.includes(id) })) }) as unknown as JobSearchConfig;

describe("the job agent's own portals (jobauto fork)", () => {
  it("asks the ones chosen for it, or on Automatic those switched on", () => {
    keys.ready = new Set(["FREEHIRE", "JSEARCH", "ADZUNA"]);
    expect(agentPortals(config("ADZUNA"), ["JSEARCH", "FREEHIRE"])).toEqual(["JSEARCH", "FREEHIRE"]);
    expect(agentPortals(config("ADZUNA", "FREEHIRE"), null)).toEqual(["ADZUNA", "FREEHIRE"]);
  });

  it("leaves out a chosen one it can't ask now, and never asks the Bundesagentur", () => {
    keys.ready = new Set(["FREEHIRE", "ARBEITSAGENTUR"]);
    expect(agentPortals(config("JSEARCH"), ["JSEARCH", "FREEHIRE", "ARBEITSAGENTUR"])).toEqual(["FREEHIRE"]);
    expect(agentPortals(config("ARBEITSAGENTUR", "FREEHIRE"), null)).toEqual(["FREEHIRE"]);
  });

  it("on Automatic with only the Bundesagentur on, takes the first portal with a key instead, or none", () => {
    keys.ready = new Set(["FREEHIRE", "ADZUNA", "SERPAPI"]);
    expect(agentPortals(config("ARBEITSAGENTUR"), null)).toEqual(["SERPAPI"]);
    keys.ready = new Set(["FREEHIRE", "ADZUNA"]);
    expect(agentPortals(config("ARBEITSAGENTUR"), null)).toEqual(["ADZUNA"]);
    keys.ready = new Set(["FREEHIRE"]);
    expect(agentPortals(config("ARBEITSAGENTUR"), null)).toEqual([]);
  });

  it("stays off while every portal is off, unless some are chosen", () => {
    keys.ready = new Set(["FREEHIRE", "JSEARCH"]);
    expect(agentPortals(config(), null)).toEqual([]);
    expect(agentPortals(config(), ["JSEARCH"])).toEqual(["JSEARCH"]);
  });

  it("offers each portal it could ask, switched on or not, and FreeHire, never the Bundesagentur", () => {
    keys.ready = new Set(["FREEHIRE", "SERPAPI", "ARBEITSAGENTUR"]);
    expect(agentPortalChoices(config("ARBEITSAGENTUR"))).toEqual(["SERPAPI", "FREEHIRE"]);
  });

  it("shows what Automatic asks, and keeps a chosen one listed when its key is gone", () => {
    keys.ready = new Set(["FREEHIRE", "SERPAPI"]);
    expect(agentPortalsView(config("SERPAPI"), ["JSEARCH"])).toEqual({
      automatic: ["SERPAPI"],
      choices: [
        { id: "SERPAPI", name: "SerpApi" },
        { id: "FREEHIRE", name: "FreeHire" },
        { id: "JSEARCH", name: "JSearch" },
      ],
    });
  });
});
