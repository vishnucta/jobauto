import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PrepTab } from "../applications/[id]/prep-tab";
import { prepareForCall } from "../applications/[id]/prep-actions";
import { preparePractice } from "./actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({ preparePractice: vi.fn(async () => ({ ok: true, data: { jobId: "job-1", reused: false } })) }));
vi.mock("../applications/[id]/prep-actions", () => ({ prepareForCall: vi.fn() }));
vi.mock("@/hooks/use-job", () => ({ useJob: () => ({ step: "Preparing your practice call" }) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const pack = {
  questions: [{ question: { de: "Erzählen Sie etwas über sich.", en: "Tell us about yourself." }, answer: { de: "Ich bin Finanzanalystin.", en: "I am a financial analyst." } }],
  salary: { de: "Ich stelle mir […] vor.", en: "I'm thinking of […]." },
  stories: [],
  toAsk: [],
  gaps: [],
  unverified: [],
};

describe("Call prep, general practice (jobauto fork)", () => {
  it("prepares a practice call from the profile, not an application's", async () => {
    const user = userEvent.setup();
    render(<PrepTab applicationId="" practice data={{ pack: null, jobId: null }} aiReady company="" />);
    expect(screen.getByRole("heading", { name: "Practise before the first call" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare my practice call" }));
    expect(preparePractice).toHaveBeenCalledWith({});
    expect(prepareForCall).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Preparing your practice call" })).toBeInTheDocument();
  });

  it("shows the pack as a practice call, ready to practise out loud", () => {
    render(<PrepTab applicationId="" practice data={{ pack, jobId: null }} aiReady company="" />);
    expect(screen.getByRole("heading", { name: "Practice call" })).toBeInTheDocument();
    expect(screen.getByText("Ich bin Finanzanalystin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Practise out loud" })).toBeInTheDocument();
    // It is the general practice already: no link to itself.
    expect(screen.queryByRole("link", { name: "General practice" })).not.toBeInTheDocument();
  });

  it("is reachable from an application's Call prep tab, before and after its pack", () => {
    const { rerender } = render(<PrepTab applicationId="a1" data={{ pack: null, jobId: null }} aiReady company="Acme" />);
    expect(screen.getByRole("link", { name: "General practice" })).toHaveAttribute("href", "/call-prep");
    rerender(<PrepTab applicationId="a1" data={{ pack, jobId: null }} aiReady company="Acme" />);
    expect(screen.getByRole("link", { name: "General practice" })).toHaveAttribute("href", "/call-prep");
  });
});
