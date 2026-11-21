import { describe, expect, it } from "vitest";

import { hasPortalKey, isJobSource, keptLabel, portalsLeftOff, portalsLeftOffNote, SOURCE_INFO, sourceInfo, type JobKeyState, type PortalView } from "./sources";
import type { JobSource } from "./search";

type Change = { on?: boolean; keyState?: JobKeyState; appId?: string; acceptedAt?: string | null; withdrawn?: boolean };

/** A built-in as Settings → Job search shows it, with a key field where it has one. */
function portal(id: JobSource, change: Change = {}): PortalView {
  const key = { name: "key", label: "API key", type: "secret" as const, keyState: change.keyState ?? "none", envName: null };
  const fields: PortalView["fields"] = id === "ADZUNA" ? [{ name: "appId", label: "App ID", type: "text", value: change.appId ?? "1234" }, key] : id === "FREEHIRE" || id === "ARBEITSAGENTUR" ? [] : [key];
  const { name, description, tag, keyUrl, quotaPeriod, countries, kinds } = SOURCE_INFO[id];
  return {
    id,
    name,
    description,
    tag,
    keyUrl,
    quotaPeriod,
    countries: countries ? [...countries] : null,
    kinds: [...kinds],
    installed: null,
    version: "1.0.0",
    withdrawal: change.withdrawn ? { reason: "Gone.", withdrawnAt: "2026-11-01", paused: true } : null,
    update: null,
    on: change.on ?? false,
    consent: id === "ARBEITSAGENTUR" ? "The BA has no official API." : null,
    acceptedAt: change.acceptedAt ?? null,
    fields,
  };
}

// After the 1.15 upgrade: three keys kept, every one of them off, and the BA on with its note accepted.
const upgraded = [
  portal("JSEARCH", { keyState: "set" }),
  portal("SERPAPI", { keyState: "env" }),
  portal("ADZUNA", { keyState: "set" }),
  portal("FREEHIRE"),
  portal("ARBEITSAGENTUR", { on: true, acceptedAt: "2026-10-23T09:00:00.000Z" }),
];

describe("keptLabel and hasPortalKey (jobauto fork)", () => {
  it("counts a key saved or from the server, with Adzuna's app ID, and not the BA's accepted note", () => {
    expect(upgraded.map(keptLabel)).toEqual(["Key saved", "Key from the server", "Key saved", null, "Note accepted"]);
    expect(upgraded.map(hasPortalKey)).toEqual([true, true, true, false, false]);
    expect(hasPortalKey(portal("ADZUNA", { keyState: "set", appId: "" }))).toBe(false);
    expect(hasPortalKey(portal("SERPAPI", { keyState: "unreadable" }))).toBe(false);
    expect(hasPortalKey(portal("SERPAPI", { keyState: "set", withdrawn: true }))).toBe(false);
  });
});

describe("portalsLeftOff (jobauto fork)", () => {
  it("names the portals with a key that are off", () => {
    expect(portalsLeftOff(upgraded)).toEqual(["JSearch", "SerpApi", "Adzuna"]);
  });

  it("is null once any of them is on, or when none has a key", () => {
    expect(portalsLeftOff(upgraded.map((entry) => (entry.id === "SERPAPI" ? { ...entry, on: true } : entry)))).toBeNull();
    expect(portalsLeftOff([portal("JSEARCH"), portal("FREEHIRE", { on: true }), portal("ARBEITSAGENTUR", { on: true, acceptedAt: "2026-10-23T09:00:00.000Z" })])).toBeNull();
  });
});

describe("portalsLeftOffNote (jobauto fork)", () => {
  it("says how many and which", () => {
    expect(portalsLeftOffNote(["JSearch", "SerpApi", "Adzuna"])).toBe("You have keys for 3 portals that are off: JSearch, SerpApi, Adzuna.");
    expect(portalsLeftOffNote(["SerpApi"])).toBe("You have a key for SerpApi, which is off.");
  });
});

describe("Jooble, which the fork removed (jobauto fork)", () => {
  it("is no portal any more, but what it found keeps its name", () => {
    expect(Object.keys(SOURCE_INFO)).not.toContain("JOOBLE");
    expect(isJobSource("JOOBLE")).toBe(false);
    expect(sourceInfo("JOOBLE")).toMatchObject({ name: "Jooble", countries: [], quotaPeriod: null });
  });
});
