import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { InterviewPanel } from "./interview-panel";

vi.mock("./actions", () => ({ addInterviewRound: vi.fn(), tickPrep: vi.fn(), updateInterview: vi.fn() }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const panel = { applicationId: "a1", interviews: [], inCalendar: false, preparing: false, aiReady: true, onPrepare: vi.fn(), fitLine: "5 of 7 requirements covered", onShowFit: vi.fn() };

describe("the Interview panel's way into Call prep (jobauto fork)", () => {
  it("opens this application's Call prep tab, and links Call prep's general practice", async () => {
    const onCallPrep = vi.fn();
    render(<InterviewPanel {...panel} onCallPrep={onCallPrep} />);
    expect(screen.getByRole("link", { name: "General practice" })).toHaveAttribute("href", "/call-prep");
    await userEvent.click(screen.getByRole("button", { name: "Call prep" }));
    expect(onCallPrep).toHaveBeenCalled();
  });
});
