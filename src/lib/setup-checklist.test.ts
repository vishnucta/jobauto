import { describe, expect, it } from "vitest";

import { setupSteps, type SetupFacts } from "./setup-checklist";

const fresh: SetupFacts = {
  agentRunning: false,
  weeklyTarget: 0,
  googleConnected: false,
  agencies: 8,
  agenciesWritten: 0,
  readinessAnswered: false,
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
    expect(steps.find((step) => step.id === "answers")?.href).toBe("/settings?section=answers");
    // Phone alerts are a Notifications channel now (E26), and Notifications delivers them (jobauto fork).
    expect(steps.find((step) => step.id === "alerts")).toMatchObject({ href: "/settings?section=notifications", action: "Open Notifications" });
    // The weekly target has one control, the This week card's; the step leads there.
    expect(steps.find((step) => step.id === "target")).toMatchObject({ href: "#weekly-target", action: "Choose a target" });
  });

  it("marks what's done, and offers the standard answers in Settings before any application (jobauto fork)", () => {
    const steps = setupSteps({ ...fresh, agentRunning: true, weeklyTarget: 5, agenciesWritten: 8 });
    expect(steps.filter((step) => step.done).map((step) => step.id)).toEqual(["agent", "target", "agencies"]);
    expect(steps.find((step) => step.id === "answers")?.href).toBe("/settings?section=answers");
  });
});
