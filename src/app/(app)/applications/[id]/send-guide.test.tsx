import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SendGuide } from "./send-guide";

const onTab = vi.fn();
const web = { kind: "web", url: "https://jobs.ledgerly.example/1", host: "jobs.ledgerly.example", atsLabel: "Personio", account: false, autoSubmitOk: false, board: false } as const;
const guide = (props: Partial<ComponentProps<typeof SendGuide>> = {}) =>
  render(<SendGuide plan={web} hasResume hasLetter hasEmail={false} waitingInBrowser={false} letterAsks={[]} onTab={onTab} {...props} />);
const sendStep = () => within(screen.getByRole("region", { name: "How to send this application" })).getAllByRole("listitem")[1];

beforeEach(() => vi.clearAllMocks());

describe("the send guide on a draft (jobauto fork)", () => {
  it("opens the documents to read, then the employer's form to fill in", async () => {
    const user = userEvent.setup();
    guide();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await user.click(screen.getByRole("button", { name: "Cover letter" }));
    expect(sendStep()).toHaveTextContent("This employer takes applications on its own page (Personio, jobs.ledgerly.example).");
    await user.click(screen.getByRole("button", { name: "Fill in its form for me" }));
    expect(onTab.mock.calls).toEqual([["resume"], ["letter"], ["apply"]]);
  });

  it("points to the browser window when the form waits there", () => {
    guide({ waitingInBrowser: true });
    expect(sendStep()).toHaveTextContent("Its form is filled in and waiting in the browser window");
    expect(screen.getByRole("button", { name: "See what was filled in" })).toBeInTheDocument();
  });

  it("sends an email employer to the Email tab, written or not", async () => {
    const user = userEvent.setup();
    const { rerender } = guide({ plan: { kind: "email", to: "bewerbung@ledgerly.example" } });
    expect(sendStep()).toHaveTextContent("This employer takes applications by email, to bewerbung@ledgerly.example.");
    await user.click(screen.getByRole("button", { name: "Write the email" }));
    expect(onTab).toHaveBeenLastCalledWith("email");
    rerender(<SendGuide plan={{ kind: "email", to: "bewerbung@ledgerly.example" }} hasResume hasLetter hasEmail waitingInBrowser={false} letterAsks={[]} onTab={onTab} />);
    expect(screen.getByRole("button", { name: "Check the email and send it" })).toBeInTheDocument();
  });

  it("links a job board's posting, and says to read the posting when there's no route", () => {
    const { unmount } = guide({ plan: { ...web, board: true, host: "www.stepstone.de", url: "https://www.stepstone.de/1" } });
    expect(sendStep()).toHaveTextContent("The posting is on a job board (www.stepstone.de).");
    expect(screen.getByRole("link", { name: /Open the posting/ })).toHaveAttribute("href", "https://www.stepstone.de/1");
    unmount();
    guide({ plan: { kind: "none" } });
    expect(screen.getByRole("button", { name: "Read the posting" })).toBeInTheDocument();
  });

  it("says what the letter still needs, and leaves marking it sent to the Email tab's button", async () => {
    const user = userEvent.setup();
    guide({ hasResume: false, letterAsks: ["salary", "start"] });
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.getByText(/The posting asks for/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "add them to your standard answers" }));
    expect(onTab).toHaveBeenLastCalledWith("apply");
    expect(screen.queryByRole("button", { name: "Mark as sent" })).not.toBeInTheDocument();
    expect(screen.getByText(/Sent it another way\? Press/)).toHaveTextContent("Mark as sent on the Email tab.");
    await user.click(screen.getByRole("button", { name: "Email tab" }));
    expect(onTab).toHaveBeenLastCalledWith("email");
  });
});
