import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DashboardFigures } from "@/lib/dashboard";

import { rememberQuietDays, rememberWeeklyTarget, startExperiment, stopExperiment } from "./actions";
import { Dashboard } from "./dashboard";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => null, useSearchParams: () => new URLSearchParams() }));
vi.mock("./actions", () => ({ rememberDashboardPeriod: vi.fn(), rememberQuietDays: vi.fn(async () => ({ ok: true, data: null })), rememberWeeklyTarget: vi.fn(async () => ({ ok: true, data: null })), startExperiment: vi.fn(async () => ({ ok: true, data: null })), stopExperiment: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const figures: DashboardFigures = {
  total: 9,
  byStatus: { DRAFT: 2, SENT: 2, SCREENING: 1, INTERVIEW: 1, OFFER: 1, ACCEPTED: 0, REJECTED: 1, DECLINED: 1 },
  funnel: [
    { stage: "SENT", count: 7, conversion: null, stopped: { open: 2, rejected: 0, declined: 0, archived: 0 } },
    { stage: "SCREENING", count: 5, conversion: 71, stopped: { open: 1, rejected: 1, declined: 0, archived: 0 } },
    { stage: "INTERVIEW", count: 3, conversion: 60, stopped: { open: 1, rejected: 0, declined: 0, archived: 0 } },
    { stage: "OFFER", count: 2, conversion: 67, stopped: { open: 1, rejected: 0, declined: 1, archived: 0 } },
    { stage: "ACCEPTED", count: 0, conversion: 0, stopped: { open: 0, rejected: 0, declined: 0, archived: 0 } },
  ],
  sent: 7,
  heardBack: 5,
  heardBackPercent: 71,
  reachedInterview: 3,
  needsYou: [
    { id: "brightline", company: "Brightline Transit", role: "Senior Service Designer", status: "DRAFT", reason: "Still a draft.", due: "apply by Thu 1 Oct", soon: true, action: "Finish draft" },
    { id: "oaken", company: "Oaken Studio", role: "Design Systems Lead", status: "OFFER", reason: "An offer is waiting on your decision.", due: null, soon: false, action: "Review offer" },
  ],
  weeks: [],
  overall: { sent: 7, heardBack: 5 },
};
const props = { figures, firstName: "Jane", period: "afternoon" as const, empty: false };

afterEach(() => vi.useRealTimers());

describe("the dashboard (E9-7)", () => {
  it("dates the day, greets by the local time and says what needs you this week (E28-1)", () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 28, 9), toFake: ["Date"] });
    render(<Dashboard {...props} today="Monday, 28 September" />);
    expect(screen.getByText("Monday, 28 September")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Good morning, Jane" })).toBeInTheDocument();
    // One of the two items is due this week.
    expect(screen.getByText(/^7 sent, 5 heard back\./)).toHaveTextContent("7 sent, 5 heard back. 1 thing needs you this week.");
    expect(screen.getByText("1 thing needs you this week.").tagName).toBe("STRONG");
    // The sidebar's is the only one in a page bar (E27-7).
    expect(screen.queryByRole("link", { name: "+ New application" })).not.toBeInTheDocument();
    expect(document.cookie).toMatch(/dossier-tz=/);
  });

  it("puts today's note at the very top, unless it's hidden for today (E28-6)", () => {
    const { rerender } = render(<Dashboard {...props} note={{ text: "Rest is part of the work.", rewritesLeft: 3 }} />);
    const note = screen.getByRole("region", { name: "Today's note" });
    expect(note.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    rerender(<Dashboard {...props} note="hidden" />);
    expect(screen.queryByRole("region", { name: "Today's note" })).not.toBeInTheDocument();
  });

  it("encourages before anything was sent, and says when nothing needs you", () => {
    const { rerender } = render(<Dashboard {...props} figures={{ ...figures, overall: { sent: 0, heardBack: 0 }, needsYou: [] }} />);
    expect(screen.getByText(/^Nothing sent yet\./)).toHaveTextContent("Nothing sent yet. Nothing needs you this week.");
    rerender(<Dashboard {...props} empty figures={{ ...figures, overall: { sent: 0, heardBack: 0 }, needsYou: [] }} />);
    expect(screen.getByText(/^Nothing sent yet\./)).toHaveTextContent("Nothing sent yet. Your first application is only a paste away.");
  });

  it("scopes only the left zone by the period; the header and this week stay (E28-1)", () => {
    render(<Dashboard {...props} range="30d" figures={{ ...figures, sent: 2, heardBack: 1 }} />);
    // The header counts all time.
    expect(screen.getByText(/^7 sent, 5 heard back\./)).toBeInTheDocument();
    const search = screen.getByRole("region", { name: "Your search so far" });
    expect(within(search).getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();
    expect(within(search).getByRole("radio", { name: "Last 30 days" })).toBeChecked();
    expect(within(search).getByRole("region", { name: "Your funnel" })).toBeInTheDocument();
    const week = screen.getByRole("region", { name: "This week · not affected by the period" });
    expect(within(week).getByRole("region", { name: "Needs you" })).toBeInTheDocument();
  });

  it("shows the funnel with its figures and notes, in words", () => {
    render(<Dashboard {...props} />);
    const funnel = screen.getByRole("region", { name: "Your funnel" });
    expect(within(funnel).getAllByRole("definition").map((value) => value.textContent)).toEqual(["7", "71%", "3", "2"]);
    expect(within(funnel).getByText("offers")).toBeInTheDocument();
    expect(within(funnel).getAllByRole("listitem").map((step) => step.textContent)).toEqual([
      "Sent7Everything you've sent",
      "Screening571% of sent",
      "Interview360% of screening",
      "Offer267% of interview",
      "Accepted0None yet",
    ]);
  });

  it("breaks down where things stand, each status opening its list, with a link to the board (E28-3)", () => {
    render(<Dashboard {...props} />);
    const standing = screen.getByRole("region", { name: "Where things stand" });
    expect(within(standing).getByRole("link", { name: "Open board" })).toHaveAttribute("href", "/applications?view=board");
    const accepted = within(standing).getByRole("link", { name: /^Accepted/ });
    expect(accepted).toHaveTextContent("Accepted0");
    expect(accepted).toHaveClass("text-muted");
    expect(accepted).toHaveAttribute("href", "/applications?status=accepted");
    expect(within(standing).getByRole("link", { name: /^Sent/ })).toHaveAttribute("href", "/applications?status=sent");
  });

  it("lists what needs you, each row's button opening its application (E28-4)", () => {
    render(<Dashboard {...props} />);
    const needs = screen.getByRole("region", { name: "Needs you" });
    const [draft, offer] = within(needs).getAllByRole("listitem");
    expect(draft).toHaveTextContent("Brightline Transit · Senior Service DesignerStill a draft. · apply by Thu 1 Oct");
    expect(within(draft).getByText("apply by Thu 1 Oct")).toHaveClass("text-warning");
    expect(within(draft).getByRole("link", { name: "Finish draft for Brightline Transit, Senior Service Designer" })).toHaveAttribute("href", "/applications/brightline");
    expect(within(offer).getByRole("link", { name: /^Review offer/ })).toHaveAttribute("href", "/applications/oaken");
    expect(offer).not.toHaveTextContent(" · null");
  });

  it("opens a reply on the Conversation tab", () => {
    const reply = { id: "meridian", company: "Meridian Bank", role: "Product Designer", status: "SENT" as const, reason: "A reply is waiting: Invites you to a call.", due: null, soon: true, action: "Answer" as const, tab: "conversation" as const };
    render(<Dashboard {...props} figures={{ ...figures, needsYou: [reply] }} />);
    expect(screen.getByRole("link", { name: /^Answer/ })).toHaveAttribute("href", "/applications/meridian?tab=conversation");
  });

  it("shows six rows, then the rest on Show all", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ ...figures.needsYou[1], id: `offer-${index}`, company: `Company ${index}` }));
    render(<Dashboard {...props} figures={{ ...figures, needsYou: many }} />);
    const needs = screen.getByRole("region", { name: "Needs you" });
    expect(within(needs).getAllByRole("listitem")).toHaveLength(6);
    await userEvent.click(within(needs).getByRole("button", { name: "Show all 8" }));
    expect(within(needs).getAllByRole("listitem")).toHaveLength(8);
    await userEvent.click(within(needs).getByRole("button", { name: "Show fewer" }));
    expect(within(needs).getAllByRole("listitem")).toHaveLength(6);
  });

  it("sets how long without news before a follow-up is suggested (E9-9)", async () => {
    const user = userEvent.setup();
    render(<Dashboard {...props} quietDays={7} />);
    const threshold = within(screen.getByRole("region", { name: "Needs you" })).getByLabelText("Suggest a follow-up after");
    expect(threshold).toHaveValue("7");
    expect(within(threshold).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "3 days",
      "5 days",
      "7 days",
      "10 days",
      "14 days",
      "21 days",
      "30 days",
    ]);
    await user.selectOptions(threshold, "14");
    expect(rememberQuietDays).toHaveBeenCalledWith({ days: 14 });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("keeps a threshold that isn't one of the choices", () => {
    render(<Dashboard {...props} quietDays={8} />);
    expect(screen.getByLabelText("Suggest a follow-up after")).toHaveValue("8");
  });

  it("is all caught up when nothing needs you", () => {
    render(<Dashboard {...props} figures={{ ...figures, needsYou: [] }} />);
    expect(screen.getByText("All caught up. Nice.")).toBeInTheDocument();
  });

  it("welcomes a new user", () => {
    render(<Dashboard {...props} empty figures={{ ...figures, sent: 0 }} />);
    expect(screen.getByRole("heading", { name: "Welcome to Dossier" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Fill in your profile" })).toHaveAttribute("href", "/profile");
    expect(screen.queryByRole("region", { name: "Your funnel" })).not.toBeInTheDocument();
  });

  it("shows the calendar after the cards, outside the time filter (E15-6)", () => {
    const calendar = <section aria-label="Calendar" />;
    const { rerender } = render(<Dashboard {...props} calendar={calendar} />);
    const region = screen.getByRole("region", { name: "Calendar" });
    expect(screen.getByRole("region", { name: "Needs you" }).compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not among the cards, which dim while another period loads.
    expect(screen.getByRole("region", { name: "Your funnel" }).parentElement!.contains(region)).toBe(false);
    // A new user has the calendar too.
    rerender(<Dashboard {...props} empty calendar={calendar} />);
    expect(screen.getByRole("region", { name: "Calendar" })).toBeInTheDocument();
  });
});

describe("This week and What's working (jobauto fork)", () => {
  const weeks = Array.from({ length: 8 }, (_, index) => ({ start: `2026-09-${String(index + 1).padStart(2, "0")}`, sent: index, met: index >= 5 }));

  it("shows this week against the target, the streak, and changes the target", async () => {
    render(<Dashboard {...props} week={{ target: 8, sent: 5, daysLeft: 3, streak: 2, weeks }} />);
    const card = screen.getByRole("region", { name: "This week" });
    expect(card).toHaveTextContent("5of 8 sent · 3 to go, 3 days left");
    expect(card).toHaveTextContent("2 weeks in a row");
    expect(within(card).getByRole("progressbar", { name: "This week's target" })).toHaveAttribute("aria-valuenow", "5");
    await userEvent.selectOptions(within(card).getByLabelText("Aim for"), "10");
    await waitFor(() => expect(rememberWeeklyTarget).toHaveBeenCalledWith({ target: 10 }));
  });

  it("shows how often each kind of application moved on, once one is sent", () => {
    const working = {
      sent: 6,
      replies: 2,
      early: true,
      groups: [{ id: "found", title: "Where you found it", rows: [{ label: "Careers pages", sent: 3, replies: 2, rejections: 0, rate: 67 }, { label: "JSearch", sent: 3, replies: 0, rejections: 1, rate: 0 }] }],
    };
    render(<Dashboard {...props} working={working} />);
    const card = screen.getByRole("region", { name: "What's working" });
    expect(card).toHaveTextContent("Of 6 sent, 2 moved on to a screening or further. With fewer than 20 sent, the differences below are hints, not answers yet.");
    expect(within(card).getByRole("row", { name: "Careers pages 3 sent 2 moved on 67%" })).toBeInTheDocument();
    expect(card).toHaveTextContent("Careers pages gets the most answers so far.");
  });

  it("leaves What's working out until something is sent", () => {
    render(<Dashboard {...props} working={{ sent: 0, replies: 0, early: true, groups: [] }} />);
    expect(screen.queryByRole("region", { name: "What's working" })).not.toBeInTheDocument();
  });
});

describe("Experiment (jobauto fork)", () => {
  it("starts one from an idea, with two versions", async () => {
    render(<Dashboard {...props} experiment={null} />);
    const card = screen.getByRole("region", { name: "Experiment" });
    await userEvent.click(within(card).getByRole("button", { name: "Letter language" }));
    expect(within(card).getByLabelText("Version B")).toHaveValue("German letter");
    await userEvent.click(within(card).getByRole("button", { name: "Start" }));
    expect(startExperiment).toHaveBeenCalledWith({ name: "Letter language", a: "English letter", b: "German letter" });
  });

  it("shows how each version has done, how far from telling it is, and stops", async () => {
    const running = {
      experiment: { name: "Letter language", a: "English letter", b: "German letter", startedAt: "2026-11-20T10:00:00.000Z" },
      results: [
        { arm: "A" as const, label: "A: English letter", sent: 3, replies: 1 },
        { arm: "B" as const, label: "B: German letter", sent: 2, replies: 0 },
      ],
    };
    render(<Dashboard {...props} experiment={running} />);
    const card = screen.getByRole("region", { name: "Experiment: Letter language" });
    expect(within(card).getByRole("row", { name: "A: English letter 3 sent 1 moved on" })).toBeInTheDocument();
    expect(card).toHaveTextContent("Too early to tell: send 2 more of A and 3 more of B.");
    await userEvent.click(within(card).getByRole("button", { name: "Stop it" }));
    expect(stopExperiment).toHaveBeenCalled();
  });
});

describe("Dashboard while scoring is off (jobauto fork)", () => {
  const scoringOff = {
    title: "Scoring is off: choose the levels your profile is for.",
    body: "Until then no posting gets a score: Best fit can't sort, How you fit doesn't run, and the job agent and strong-match alerts wait.",
    reason: "Choose the levels your profile is for. Nothing is scored until you do.",
    href: "/profile?section=target&profile=p1",
    profileId: "p1",
    canGuess: false,
  };

  it("says so first, across both zones, until the levels are chosen", () => {
    const { rerender } = render(<Dashboard {...props} scoringOff={scoringOff} />);
    const notice = screen.getByRole("region", { name: "Scoring is off" });
    expect(notice).toHaveTextContent("Scoring is off: choose the levels your profile is for.");
    expect(notice).toHaveClass("col-span-full");
    expect(within(notice).getByRole("link", { name: "Choose levels" })).toHaveAttribute("href", "/profile?section=target&profile=p1");
    rerender(<Dashboard {...props} scoringOff={null} />);
    expect(screen.queryByRole("region", { name: "Scoring is off" })).not.toBeInTheDocument();
  });
});
