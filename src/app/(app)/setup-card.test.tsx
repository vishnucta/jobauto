import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { setupSteps } from "@/lib/setup-checklist";

import { SetupCard } from "./setup-card";

const facts = { agentRunning: true, weeklyTarget: 0, googleConnected: false, agencies: 8, agenciesWritten: 0, readinessAnswered: false, networkImported: false, phoneAlerts: false, careersFollowed: 0 };

describe("Start here", () => {
  it("lists what's left, each a click, the weekly target's leading to the This week card", () => {
    render(<SetupCard steps={setupSteps(facts)} />);
    expect(screen.getByText("1 of 8 done")).toBeInTheDocument();
    expect(screen.queryByText("Let the job agent search every morning")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Recruiters" })).toHaveAttribute("href", "/recruiters");
    expect(screen.getByRole("link", { name: "Open the standard answers" })).toHaveAttribute("href", "/settings?section=answers");
    // One control for the target (jobauto fork): no button here that sets it.
    expect(screen.getByRole("link", { name: "Choose a target" })).toHaveAttribute("href", "#weekly-target");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Notifications" })).toHaveAttribute("href", "/settings?section=notifications");
  });

  it("drops the target's step once a target is set, and is gone once everything is in use", () => {
    const { container, rerender } = render(<SetupCard steps={setupSteps({ ...facts, weeklyTarget: 5 })} />);
    expect(screen.queryByText("Set a weekly target")).not.toBeInTheDocument();
    rerender(<SetupCard steps={setupSteps({ ...facts, weeklyTarget: 5, googleConnected: true, agenciesWritten: 8, readinessAnswered: true, networkImported: true, phoneAlerts: true, careersFollowed: 3 })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
