import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendStep } from "@/lib/apply/send-step";

import { SendGuide } from "./send-guide";

const onTab = vi.fn();
const web = { kind: "web", url: "https://jobs.ledgerly.example/1", host: "jobs.ledgerly.example", atsLabel: "Personio", account: false, autoSubmitOk: false, board: false } as const;
const quiet = { hasEmail: false, waitingInBrowser: false, gmailSends: false };
const guide = () => screen.getByRole("region", { name: "How to send this application" });

beforeEach(() => vi.clearAllMocks());

describe("the send guide on a draft, one line (jobauto fork)", () => {
  it("says how this employer takes applications and what marks it sent, with no button of its own", async () => {
    const user = userEvent.setup();
    render(<SendGuide step={sendStep(web, quiet)} letterAsks={[]} onTab={onTab} />);
    expect(guide()).toHaveTextContent("How to send it: This employer takes applications on its own page (Personio, jobs.ledgerly.example). Sending it through the form marks it sent.");
    // The header has the one button; the guide only links the Email tab for Mark as sent.
    expect(screen.queryByRole("button", { name: "Fill in its form" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Email tab" }));
    expect(onTab).toHaveBeenLastCalledWith("email");
  });

  it("names Gmail only when Gmail can send it", () => {
    const { rerender } = render(<SendGuide step={sendStep({ kind: "email", to: "bewerbung@ledgerly.example" }, quiet)} letterAsks={[]} onTab={onTab} />);
    expect(guide()).not.toHaveTextContent("Gmail");
    expect(guide()).toHaveTextContent("Send it from your own mail with the PDFs attached, then press Mark as sent on the Email tab.");
    rerender(<SendGuide step={sendStep({ kind: "email", to: "bewerbung@ledgerly.example" }, { ...quiet, gmailSends: true })} letterAsks={[]} onTab={onTab} />);
    expect(guide()).toHaveTextContent("Sending it with Gmail marks it sent.");
  });

  it("says what the letter still needs, with a link to the standard answers in Settings", () => {
    render(<SendGuide step={sendStep({ kind: "none" }, quiet)} letterAsks={["salary", "start"]} onTab={onTab} />);
    expect(screen.getByText(/The posting asks for/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "add them to your standard answers" })).toHaveAttribute("href", "/settings?section=answers");
  });
});
