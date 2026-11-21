import { describe, expect, it } from "vitest";

import { setupSteps, type SetupFacts } from "./setup-checklist";

const fresh: SetupFacts = {
  agentRunning: false,
  weeklyTarget: 0,
  googleConnected: false,
  agencies: 8,
  agenciesWritten: 0,
  readinessAnswered: false,
  answersApplicationId: "app-1",
  networkImported: false,
  phoneAlerts: false,
  careersFollowed: 0,
};

describe("setupSteps", () => {
  it("lists every way in she isn't using yet, in the order they pay off", () => {
    const steps = setupSteps(fresh);
    expect(steps.map((step) => step.id)).toEqual(["agent", "target", "agencies", "answers", "google", "careers", "network", "alerts"]);
    expect(steps.every((step) => !step.done)).toBe(true);
    expect(steps.find((step) => step.id === "agencies")?.title).toBe("Write to the 8 agencies on your list");
    expect(steps.find((step) => step.id === "answers")?.href).toBe("/applications/app-1?tab=apply");
    // Phone alerts are a Notifications channel now (E26).
    expect(steps.find((step) => step.id === "alerts")?.href).toBe("/settings?section=notifications");
  });

  it("marks what's done, and leaves out the answers until there's an application to hold them", () => {
    const steps = setupSteps({ ...fresh, agentRunning: true, weeklyTarget: 5, agenciesWritten: 8, answersApplicationId: null });
    expect(steps.filter((step) => step.done).map((step) => step.id)).toEqual(["agent", "target", "agencies"]);
    expect(steps.map((step) => step.id)).not.toContain("answers");
  });
});
