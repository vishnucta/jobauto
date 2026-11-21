import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { matchFromRequirements } from "@/lib/application-data";

import { FitColumn } from "./fit-column";

const match = matchFromRequirements([
  { text: "Regulatory reporting", mustHave: true, covered: true, evidence: null },
  { text: "SQL", mustHave: false, covered: false, evidence: null },
]);

describe("FitColumn's overlay", () => {
  it("opens from the rail or the phone's button and closes again", async () => {
    render(
      <FitColumn match={match}>
        <p>What they ask for</p>
      </FitColumn>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show how you fit: 1 of 2 requirements covered" }));
    const dialog = screen.getByRole("dialog", { name: "How you fit" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes with an X on a phone, where it fills the screen, and folds back on wider windows (jobauto fork)", async () => {
    render(
      <FitColumn match={match} open onOpenChange={() => {}}>
        <p>What they ask for</p>
      </FitColumn>,
    );
    const close = within(screen.getByRole("dialog", { name: "How you fit" })).getByRole("button", { name: "Close" });
    const [wide, phone] = [...close.querySelectorAll("svg")];
    expect(wide).toHaveClass("lucide-panel-left-close", "max-sm:hidden");
    expect(phone).toHaveClass("lucide-x", "sm:hidden");
  });
});
