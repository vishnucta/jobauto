import { describe, expect, it } from "vitest";

import { armLabel, inRun, nextArm, runWhere, verdict } from "./experiments";

const experiment = { name: "Letter language", a: "English letter", b: "German letter" };
const result = (arm: "A" | "B", sent: number, replies: number) => ({ arm, label: armLabel(experiment, arm), sent, replies });

describe("experiments", () => {
  it("gives a new application the version with fewer so far, A on a tie", () => {
    expect(nextArm({ A: 0, B: 0 })).toBe("A");
    expect(nextArm({ A: 1, B: 0 })).toBe("B");
    expect(nextArm({ A: 3, B: 5 })).toBe("A");
  });

  it("says it's too early until each version has enough sent", () => {
    expect(verdict([result("A", 5, 2), result("B", 3, 0)])).toBe("Too early to tell: send 2 more of B.");
    expect(verdict([result("A", 0, 0), result("B", 0, 0)])).toBe("Too early to tell: send 5 more of A and 5 more of B.");
  });

  it("only ever leans one way, from small numbers", () => {
    expect(verdict([result("A", 6, 1), result("B", 6, 3)])).toBe("Leaning towards B: German letter, from small numbers: keep going before you decide.");
    expect(verdict([result("A", 10, 3), result("B", 10, 3)])).toBe("No clear difference yet: both get answers about as often.");
  });

  it("counts only this run: the same name started again begins from nothing", () => {
    const run = { name: "Headline", startedAt: "2026-11-20T09:00:00.000Z" };
    expect(runWhere(run)).toEqual({ experiment: "Headline", createdAt: { gte: new Date("2026-11-20T09:00:00.000Z") } });
    expect(inRun(run, { experiment: "Headline", createdAt: new Date("2026-11-20T10:00:00Z") })).toBe(true);
    expect(inRun(run, { experiment: "Headline", createdAt: new Date("2026-11-19T10:00:00Z") })).toBe(false);
    expect(inRun(run, { experiment: "Letter language", createdAt: new Date("2026-11-20T10:00:00Z") })).toBe(false);
  });
});
