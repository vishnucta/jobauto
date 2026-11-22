import { describe, expect, it } from "vitest";

import { sendChannel, sendStep, sendTab } from "./send-step";
import type { ApplyPlanView } from "./view";

const form: ApplyPlanView = { kind: "web", url: "https://jobs.example/apply/1", host: "jobs.example", atsLabel: "Personio", account: false, autoSubmitOk: false, board: false };
const board: ApplyPlanView = { ...form, url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/1", host: "arbeitsagentur.de", atsLabel: "the Bundesagentur", board: true };
const email: ApplyPlanView = { kind: "email", to: "jobs@ledgerly.example" };
const quiet = { hasEmail: false, waitingInBrowser: false, gmailSends: false };

describe("sendChannel", () => {
  it("tells the employer's form from a job board", () => {
    expect(sendChannel(form)).toBe("form");
    expect(sendChannel(board)).toBe("board");
    expect(sendChannel(email)).toBe("email");
    expect(sendChannel({ kind: "none" })).toBe("none");
  });
});

describe("sendTab (Send on a card or a list row)", () => {
  it("opens where the step's button goes", () => {
    expect(sendTab(email)).toBe("email");
    expect(sendTab(form)).toBe("apply");
    expect(sendTab({ kind: "none" })).toBe("posting");
    // The job board's link is the guide's button above the documents.
    expect(sendTab(board)).toBe("resume");
  });
});

describe("sendStep (one send path)", () => {
  it("sends an email posting to the Email tab, and names Gmail only when it can send", () => {
    expect(sendStep(email, quiet)).toMatchObject({ label: "Write the email", target: { tab: "email" }, how: "This employer takes applications by email, to jobs@ledgerly.example." });
    expect(sendStep(email, quiet).after).not.toMatch(/Gmail/);
    expect(sendStep(email, { ...quiet, hasEmail: true, gmailSends: true })).toMatchObject({ label: "Send the email", after: "Sending it with Gmail marks it sent." });
  });

  it("sends a form posting to the Apply tab", () => {
    expect(sendStep(form, quiet)).toMatchObject({ channel: "form", label: "Fill in its form", target: { tab: "apply" } });
    expect(sendStep(form, quiet).how).toBe("This employer takes applications on its own page (Personio, jobs.example).");
    expect(sendStep(form, { ...quiet, waitingInBrowser: true })).toMatchObject({ label: "See what was filled in" });
    // No "the employer's website" before the host.
    expect(sendStep({ ...form, atsLabel: "the employer's website", host: "doerner.de" }, quiet).how).toBe("This employer takes applications on its own page (doerner.de).");
  });

  it("opens a job board's posting rather than the Email tab (the audit's Fielmann case)", () => {
    expect(sendStep(board, quiet)).toMatchObject({ channel: "board", label: "Apply on the job board", target: { href: board.kind === "web" ? board.url : "" } });
    expect(sendStep(board, quiet).how).toMatch(/Bewerbungsmappe/);
  });

  it("points to the posting when there's no route", () => {
    expect(sendStep({ kind: "none" }, quiet)).toMatchObject({ label: "Read the posting", target: { tab: "posting" } });
  });
});
