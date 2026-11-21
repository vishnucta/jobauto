import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { setupSteps } from "@/lib/setup-checklist";

import { rememberWeeklyTarget } from "./actions";
import { SetupCard } from "./setup-card";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("./actions", () => ({ rememberWeeklyTarget: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const facts = { agentRunning: true, weeklyTarget: 0, googleConnected: false, agencies: 8, agenciesWritten: 0, readinessAnswered: false, answersApplicationId: "app-1", networkImported: false, phoneAlerts: false, careersFollowed: 0 };

describe("Start here", () => {
  it("lists what's left, each a click, and sets the weekly target in place", async () => {
    const user = userEvent.setup();
    render(<SetupCard steps={setupSteps(facts)} />);
    expect(screen.getByText("1 of 8 done")).toBeInTheDocument();
    expect(screen.queryByText("Let the job agent search every morning")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Recruiters" })).toHaveAttribute("href", "/recruiters");
    expect(screen.getByRole("link", { name: "Open the standard answers" })).toHaveAttribute("href", "/applications/app-1?tab=apply");
    await user.click(screen.getByRole("button", { name: "Aim for 5 a week" }));
    expect(rememberWeeklyTarget).toHaveBeenCalledWith({ target: 5 });
    expect(refresh).toHaveBeenCalled();
  });

  it("is gone once everything is in use", () => {
    const { container } = render(
      <SetupCard steps={setupSteps({ ...facts, weeklyTarget: 5, googleConnected: true, agenciesWritten: 8, readinessAnswered: true, networkImported: true, phoneAlerts: true, careersFollowed: 3 })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
