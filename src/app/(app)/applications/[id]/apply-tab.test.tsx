import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import { DEFAULT_APPLY_ANSWERS } from "@/lib/apply/answers";
import type { ApplyAttemptView, ApplyTabData } from "@/lib/apply/view";
import type { JobView } from "@/lib/jobs/runner";

import { fillThisPage, startApply } from "./apply-actions";
import { ApplyTab } from "./apply-tab";

// The Apply tab's run card and its "Fill this page" button (jobauto fork).

vi.mock("./apply-actions", () => ({
  startApply: vi.fn(async () => ({ ok: true, data: { jobId: "job-1", attemptId: "run-2" } })),
  fillThisPage: vi.fn(async () => ({ ok: true, data: { jobId: "job-9", attemptId: "run-1" } })),
  saveApplyAnswers: vi.fn(async () => ({ ok: true, data: null })),
  settleApplyAttempt: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
// Jobs report whatever the test says, as the real hook would.
const jobs = vi.hoisted(() => ({ listeners: new Map<string, (job: unknown) => void>() }));
vi.mock("@/hooks/use-job", async () => {
  const { useEffect } = await import("react");
  return {
    useJob: (id: string | null, _revision: number, onChange?: (job: unknown) => void) => {
      useEffect(() => {
        if (!id) return;
        jobs.listeners.set(id, (job) => onChange?.(job));
        return () => void jobs.listeners.delete(id);
      });
      return null;
    },
  };
});

function report(job: Partial<JobView>) {
  const view = { id: "job-9", type: "apply-page", status: "RUNNING", step: null, error: null, result: null, ...job };
  act(() => jobs.listeners.get(view.id)?.(view));
}

const BLOCKED = "The site's security check took the assistant's browser for a bot, so the page didn't load and I didn't touch it.";

const attempt = (over: Partial<ApplyAttemptView> = {}): ApplyAttemptView => ({
  id: "run-1",
  status: "WAITING",
  note: BLOCKED,
  startedAt: "4 Nov, 05:34",
  host: "www.learn4good.com",
  filled: [],
  unfilled: [],
  captcha: false,
  screenshot: false,
  confirmation: false,
  autoSubmit: false,
  watching: true,
  ...over,
});

const tabData = (over: Partial<ApplyTabData> = {}): ApplyTabData => ({
  plan: { kind: "web", url: "https://www.learn4good.com/jobs/1/", host: "www.learn4good.com", atsLabel: "the employer's website", account: false, autoSubmitOk: false, board: true },
  answers: DEFAULT_APPLY_ANSWERS,
  attempts: [attempt()],
  running: null,
  runningKind: null,
  hasResume: true,
  hasLetter: true,
  missing: [],
  ...over,
});

const renderTab = (data: ApplyTabData = tabData()) => render(<ApplyTab applicationId="app-1" data={data} onGoToEmail={() => {}} />);

/** The run's card, by its heading. */
const card = (name: string) => within(screen.getByRole("heading", { name: new RegExp(name) }).closest("section")!);

beforeEach(() => {
  vi.clearAllMocks();
  jobs.listeners.clear();
});

describe("Fill this page, in the run's card", () => {
  it("is the first button in the row, ahead of I sent it and I didn't send it", () => {
    renderTab();
    const waiting = card("Waiting for you");
    expect(waiting.getAllByRole("button").map((button) => button.textContent)).toEqual(["Fill this page", "I sent it", "I didn't send it"]);
    expect(waiting.getByRole("button", { name: "Fill this page" })).not.toHaveAttribute("aria-disabled");
    expect(waiting.getByText(/Get to the form in the browser window, then click Fill this page/)).toBeInTheDocument();
  });

  it("starts, and shows its own steps in the card while the first panel stays as it was", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(card("Waiting for you").getByRole("button", { name: "Fill this page" }));
    expect(fillThisPage).toHaveBeenCalledWith({ id: "app-1" });
    expect(startApply).not.toHaveBeenCalled();

    const waiting = card("Waiting for you");
    expect(waiting.getByRole("button", { name: "Filling this page…" })).toHaveAttribute("aria-disabled", "true");
    expect(waiting.getByText("Reading the page")).toBeInTheDocument();
    // The run's own steps belong to opening the employer's page, not to this.
    expect(screen.queryByText("Preparing your PDFs")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open and fill it in again" })).toHaveAttribute("aria-disabled", "true");

    report({ step: "Attaching your PDFs" });
    expect(waiting.getByText("Attaching your PDFs").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("reloads the page when it is done, and offers itself again", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(card("Waiting for you").getByRole("button", { name: "Fill this page" }));
    report({ status: "DONE", result: { attemptId: "run-1", status: "WAITING", note: "Filled in this page." } });
    expect(router.refresh).toHaveBeenCalled();
    expect(card("Waiting for you").getByRole("button", { name: "Fill this page" })).not.toHaveAttribute("aria-disabled");
  });

  it("says so when it fails, and offers itself again", async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(card("Waiting for you").getByRole("button", { name: "Fill this page" }));
    report({ status: "FAILED", error: "Something went wrong while working on this. Try again." });
    expect(toast).toHaveBeenLastCalledWith("Something went wrong while working on this. Try again.");
    expect(card("Waiting for you").getByRole("button", { name: "Fill this page" })).not.toHaveAttribute("aria-disabled");
  });

  it("says why it didn't start", async () => {
    const user = userEvent.setup();
    vi.mocked(fillThisPage).mockResolvedValueOnce({ ok: false, error: "There's no run waiting for you on this application. Start one with Open and fill it in." });
    renderTab();
    await user.click(card("Waiting for you").getByRole("button", { name: "Fill this page" }));
    expect(toast).toHaveBeenLastCalledWith("There's no run waiting for you on this application. Start one with Open and fill it in.");
    expect(screen.queryByRole("button", { name: "Filling this page…" })).not.toBeInTheDocument();
  });

  it("is off, and says why, when the server isn't watching the window any more", async () => {
    const user = userEvent.setup();
    renderTab(tabData({ attempts: [attempt({ watching: false })] }));
    const waiting = card("Waiting for you");
    const button = waiting.getByRole("button", { name: "Fill this page" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(waiting.getByText(/so Fill this page can't reach it/)).toBeInTheDocument();
    expect(waiting.queryByText(/Get to the form in the browser window/)).not.toBeInTheDocument();
    await user.click(button);
    expect(fillThisPage).not.toHaveBeenCalled();
  });

  it("isn't offered on a run that ended, which has no window to fill", () => {
    renderTab(tabData({ attempts: [attempt({ status: "ABANDONED", watching: false, note: "The browser tab was closed before I saw a confirmation." })] }));
    const ended = card("Not sent");
    expect(ended.queryByRole("button", { name: "Fill this page" })).not.toBeInTheDocument();
    expect(ended.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("follows a fill that was going when the page loaded, with the card in view", () => {
    renderTab(tabData({ running: "job-9", runningKind: "page" }));
    const waiting = card("Waiting for you");
    expect(waiting.getByRole("button", { name: "Filling this page…" })).toHaveAttribute("aria-disabled", "true");
    expect(waiting.getByText("Reading the page")).toBeInTheDocument();
  });

  it("shows a run that is still opening the employer's page as before: its steps, and no card", () => {
    renderTab(tabData({ running: "job-1", runningKind: "run" }));
    expect(screen.getByText("Preparing your PDFs")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Waiting for you/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fill this page/ })).not.toBeInTheDocument();
  });
});

describe("what was filled in, by step of the form", () => {
  const filled = [
    { label: "First name", what: "First name", value: "", page: 1 },
    { label: "Lebenslauf", what: "PDF", value: "CV.pdf", page: 1 },
    { label: "Kündigungsfrist", what: "Notice period", value: "keine", page: 2 },
    { label: "Warum möchten Sie bei uns arbeiten?", what: "Written by the AI", value: "Ich arbeite gern mit Zahlen.", page: 2, byAi: true },
    { label: "Verfügbar ab", what: "Start date", value: "sofort", page: 2 },
  ];

  it("lists the page just filled first, then the earlier ones, with counts", () => {
    renderTab(tabData({ attempts: [attempt({ filled, note: "Filled in this page." })] }));
    const waiting = card("Waiting for you");
    expect(waiting.getByText(/What I filled in \(3 on this page, 2 earlier\)/)).toBeInTheDocument();
    const headings = waiting.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["This page · step 2", "Earlier · step 1"]);
    const lists = waiting.getAllByRole("list");
    expect(within(lists[0]).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Kündigungsfrist· Notice period · keine",
      "Warum möchten Sie bei uns arbeiten?· Written by the AI · Ich arbeite gern mit Zahlen.",
      "Verfügbar ab· Start date · sofort",
    ]);
    expect(within(lists[1]).getAllByRole("listitem")).toHaveLength(2);
  });

  it("puts the optional fields it left with the page it just filled", () => {
    renderTab(tabData({ attempts: [attempt({ filled, unfilled: [{ label: "Wie sind Sie auf uns aufmerksam geworden?", required: false, reason: "I don't know what goes here" }] })] }));
    const lists = card("Waiting for you").getAllByRole("list");
    expect(within(lists[0]).getByText(/Wie sind Sie auf uns aufmerksam geworden\?/)).toBeInTheDocument();
    expect(within(lists[1]).queryByText(/Wie sind Sie/)).not.toBeInTheDocument();
  });

  it("shows a run from before steps were kept, or with one step, as a single list", () => {
    renderTab(tabData({ attempts: [attempt({ filled: [{ label: "First name", what: "First name", value: "" }, { label: "Last name", what: "Last name", value: "" }] })] }));
    const waiting = card("Waiting for you");
    expect(waiting.getByText(/What I filled in \(2\)/)).toBeInTheDocument();
    expect(waiting.queryAllByRole("heading", { level: 4 })).toHaveLength(0);
  });
});
