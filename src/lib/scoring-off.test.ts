import { describe, expect, it } from "vitest";

import type { LevelsProblem } from "@/lib/profiles";

import { scoringOff } from "./scoring-off";

const waiting = (profileId: string, name: string): LevelsProblem => ({ profileId, name, message: `Set the levels for “${name}” first.`, href: `/profile?section=target&profile=${profileId}` });

describe("scoringOff (jobauto fork)", () => {
  it("is null while every profile scored against has its levels", () => {
    expect(scoringOff([], 1)).toBeNull();
    expect(scoringOff([null, null], 2)).toBeNull();
  });

  it("is off altogether with one profile and no levels, and says where to choose them", () => {
    expect(scoringOff([waiting("p1", "Erika Mustermann")], 1)).toEqual({
      title: "Scoring is off: choose the levels your profile is for.",
      body: "Until then no posting gets a score: Best fit can't sort, How you fit doesn't run, and the job agent and strong-match alerts wait.",
      reason: "Choose the levels your profile is for. Nothing is scored until you do.",
      href: "/profile?section=target&profile=p1",
      profileId: "p1",
    });
  });

  it("is off altogether when none of several profiles has levels, pointing at the first", () => {
    const off = scoringOff([waiting("p1", "Controlling"), waiting("p2", "Reporting")], 2)!;
    expect(off.title).toBe("Scoring is off: choose the levels your profiles are for.");
    expect(off.reason).toBe("Choose the levels your profiles are for. Nothing is scored until you do.");
    expect(off.profileId).toBe("p1");
  });

  it("names only the profiles that wait when others have their levels", () => {
    const one = scoringOff([null, waiting("p2", "Reporting")], 2)!;
    expect(one.title).toBe("Scoring is off for “Reporting”: choose the levels it's for.");
    expect(one.body).toBe("Until then no posting is scored against it.");
    expect(one.reason).toBe("Choose the levels “Reporting” is for. Nothing is scored against it until you do.");
    expect(one.href).toBe("/profile?section=target&profile=p2");

    const two = scoringOff([waiting("p1", "Controlling"), null, waiting("p3", "Treasury")], 3)!;
    expect(two.title).toBe("Scoring is off for “Controlling” and “Treasury”: choose the levels they're for.");
    expect(two.body).toBe("Until then no posting is scored against them.");
  });

  it("names the agent's one profile among several without calling it off altogether", () => {
    expect(scoringOff([waiting("p1", "Controlling")], 2)!.title).toBe("Scoring is off for “Controlling”: choose the levels it's for.");
  });
});
