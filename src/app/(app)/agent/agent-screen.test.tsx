import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { AgentCandidateView, AgentView } from "@/lib/agent/view";

import { approveAgentDraft, dismissAgentCandidate, prepareAgentDraft, restoreAgentCandidate, runAgentNow } from "./actions";
import { AgentScreen } from "./agent-screen";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/agent" }));
vi.mock("@/hooks/use-job", () => ({ useJob: () => null }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean }) => result }));
vi.mock("./actions", () => ({
  runAgentNow: vi.fn(async () => ({ ok: true, data: { jobId: "run-1", reused: false } })),
  prepareAgentDraft: vi.fn(async () => ({ ok: true, data: { jobId: "draft-1", applicationId: null } })),
  approveAgentDraft: vi.fn(async () => ({ ok: true, data: { applicationId: "app-1" } })),
  dismissAgentCandidate: vi.fn(async () => ({ ok: true, data: { undo: null } })),
  restoreAgentCandidate: vi.fn(async () => ({ ok: true, data: null })),
}));

const card = (id: string, score: number, extra: Partial<AgentCandidateView> = {}): AgentCandidateView => ({
  searches: [],
  id,
  title: `Posting ${id}`,
  company: `Company ${id}`,
  facts: "Rotterdam · €70k",
  origin: "Posted 2 days ago · via LinkedIn on JSearch",
  source: "JSEARCH",
  url: `https://jobs.example/${id}`,
  score,
  reasons: [`Reason for ${id}`],
  redFlags: [],
  error: null,
  applicationId: null,
  draftJobId: null,
  ...extra,
});
const view: AgentView = {
  searches: [],
  sourceRequestsUsed: 0,
  nextEligibility: "Wed 21 Oct, 07:00",
  timeZone: "Europe/Berlin",
  searchHistory: [],
  searchResults: [],
  enabled: true,
  autoDraft: false,
  minScore: 70,
  maxScores: 15,
  maxDrafts: 3,
  setupProblem: null,
  setupSection: null,
  limitReached: false,
  lastRun: { at: "Tue 20 Oct, 07:00", message: "2 new postings are waiting for a look." },
  nextRun: "Wed 21 Oct, 07:00",
  runJobId: null,
  drafts: [card("d1", 91, { applicationId: "app-1" })],
  scored: [card("s1", 84, { redFlags: ["German required"], error: "The draft couldn't be prepared. Try again." }), card("s2", 72)],
  belowMinimum: [card("b1", 40)],
};
const open = (changes: Partial<AgentView> = {}) => render(<AgentScreen view={{ ...view, ...changes }} />);

beforeEach(() => vi.clearAllMocks());

describe("AgentScreen (E16-6)", () => {
  it.each([null, "The agent scan was interrupted. Try again."])("does not present a collected source page as overall success for batch outcome %s", (batchMessage) => {
    const search = { id: "one", name: "Incomplete", query: { keywords: "Designer", place: "", country: "", radiusKm: 25 as const, remoteOnly: false, postedWithin: "any" as const }, enabled: false, sort: 0, createdAt: new Date(), updatedAt: new Date() };
    open({ searches: [search], searchHistory: [{ searchId: "one", searchName: search.name, found: 3, fresh: 0, error: null, at: "Tue 20 Oct, 07:00", batchMessage }] });
    expect(screen.getByText("Designer · No country selected")).toBeInTheDocument();
    expect(screen.getByText(/Last source request completed:/)).toBeInTheDocument();
    expect(screen.queryByText(/Last success/)).not.toBeInTheDocument();
    expect(screen.getByText(batchMessage ? `Batch outcome: ${batchMessage}` : "Batch pending or still processing; discovery counts may be incomplete.")).toBeInTheDocument();
  });

  it("shows quota, per-search results and historical attribution without changing review actions", () => {
    const search = { id: "one", name: "Renamed", query: { keywords: "Designer", place: "Berlin", country: "de", radiusKm: 25 as const, remoteOnly: false, postedWithin: "any" as const }, enabled: true, sort: 0, createdAt: new Date(), updatedAt: new Date() };
    const result = { searchId: "one", searchName: "Original", found: 10, fresh: 4, error: "Source failed" };
    open({ searches: [search], sourceRequestsUsed: 2, limitReached: true, searchHistory: [{ ...result, at: "Tue 20 Oct, 07:00", batchMessage: "Interrupted" }], searchResults: [result, { ...result, searchId: "gone", searchName: "Removed", error: null }], scored: [card("s1", 84, { searches: [{ searchId: "one", searchName: "Original" }, { searchId: null, searchName: "Removed" }] })] });
    expect(screen.getByText("Source requests available").nextElementSibling).toHaveTextContent("1 of 3");
    expect(screen.getByText("Whole-batch quota eligibility").nextElementSibling).toHaveTextContent("Wed 21 Oct, 07:00 (Europe/Berlin)");
    expect(screen.getByText("Renamed · Enabled")).toBeInTheDocument();
    expect(screen.getByText(/Last source request failed:/)).toHaveTextContent("10 found · 4 new to agent");
    expect(screen.getByText("Run as “Original”")).toBeInTheDocument();
    expect(screen.getByText(/Removed \(deleted search\):/)).toBeInTheDocument();
    expect(screen.getByText("Found by: Original · Removed (deleted search)")).toBeInTheDocument();
    expect(screen.getByText(/Found counts may overlap/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare draft" })).toBeInTheDocument();
  });

  it("says what it searches, when it ran and when it runs next", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Job agent" })).toBeInTheDocument();
    expect(screen.getByText("Enabled searches").nextElementSibling).toHaveTextContent("0 of 0");
    expect(screen.getByText("Last run").nextElementSibling).toHaveTextContent("Tue 20 Oct, 07:002 new postings are waiting for a look.");
    expect(screen.getByText("Next run").nextElementSibling).toHaveTextContent("Wed 21 Oct, 07:00");
  });

  it("lists drafts to review with a link to the draft, Approve and Dismiss", async () => {
    const user = userEvent.setup();
    open();
    const drafts = screen.getByRole("region", { name: "Drafts to review" });
    expect(within(drafts).getByRole("heading", { level: 3, name: "Posting d1" })).toBeInTheDocument();
    expect(within(drafts).getByRole("img", { name: "Score 91 of 100" })).toBeInTheDocument();
    expect(within(drafts).getByRole("link", { name: "Review draft" })).toHaveAttribute("href", "/applications/app-1");
    await user.click(within(drafts).getByRole("button", { name: "Approve" }));
    expect(approveAgentDraft).toHaveBeenCalledWith({ candidateId: "d1" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("asks before dismissing a draft, since it deletes it", async () => {
    const user = userEvent.setup();
    open();
    await user.click(within(screen.getByRole("region", { name: "Drafts to review" })).getByRole("button", { name: "Dismiss" }));
    const dialog = screen.getByRole("alertdialog", { name: "Dismiss this draft?" });
    expect(dismissAgentCandidate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Dismiss draft" }));
    expect(dismissAgentCandidate).toHaveBeenCalledWith({ candidateId: "d1" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Dismissed, with its draft. It won't come back."));
  });

  it("lists scored postings best first, with reasons, red flags, a failed draft's error and the posting's link", () => {
    open();
    const scored = screen.getByRole("region", { name: "Scored postings" });
    expect(within(scored).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Posting s1", "Posting s2"]);
    expect(within(scored).getAllByRole("list", { name: "Why it fits" })[0]).toHaveTextContent("Reason for s1");
    expect(within(scored).getByText("German required")).toBeInTheDocument();
    expect(within(scored).getByRole("alert")).toHaveTextContent("The draft couldn't be prepared. Try again.");
    const [link] = within(scored).getAllByRole("link", { name: /Open posting/ });
    expect(link).toHaveAttribute("href", "https://jobs.example/s1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("labels Adzuna's postings with a link to Adzuna, as its terms ask", () => {
    open({ scored: [card("s1", 84, { source: "ADZUNA", url: "https://www.adzuna.nl/land/ad/1" }), card("s2", 72)] });
    const scored = screen.getByRole("region", { name: "Scored postings" });
    expect(within(scored).getByRole("link", { name: "Jobs by Adzuna (opens in a new tab)" })).toHaveAttribute("href", "https://www.adzuna.nl");
  });

  it("keeps postings below the minimum score behind Show", async () => {
    const user = userEvent.setup();
    open();
    expect(screen.queryByText("Posting b1")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "1 below your minimum score of 70 · Show" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Posting b1")).toBeInTheDocument();
  });

  it("prepares a draft from a scored posting", async () => {
    const user = userEvent.setup();
    open();
    const [prepare] = screen.getAllByRole("button", { name: "Prepare draft" });
    await user.click(prepare);
    expect(prepareAgentDraft).toHaveBeenCalledWith({ candidateId: "s1" });
    expect(screen.getAllByRole("button", { name: /Preparing draft…|Prepare draft/ })[0]).toHaveTextContent("Preparing draft…");
  });

  it("dismisses a scored posting at once, with Undo", async () => {
    const user = userEvent.setup();
    const undo = { id: "s2", place: "Rotterdam", remote: false, salary: "", postedAt: null, url: "https://jobs.example/s2", via: "", description: "Text", complete: true, reasons: ["Reason for s2"], redFlags: [] };
    vi.mocked(dismissAgentCandidate).mockResolvedValueOnce({ ok: true, data: { undo } });
    open();
    const scored = screen.getByRole("region", { name: "Scored postings" });
    await user.click(within(scored).getAllByRole("button", { name: "Dismiss" })[1]);
    expect(dismissAgentCandidate).toHaveBeenCalledWith({ candidateId: "s2" });
    await waitFor(() => expect(screen.queryByText("Posting s2")).not.toBeInTheDocument());
    expect(toast).toHaveBeenLastCalledWith("Dismissed. It won't come back.", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) }));

    const { action } = vi.mocked(toast).mock.calls.at(-1)![1]!;
    await act(async () => action!.onClick());
    expect(restoreAgentCandidate).toHaveBeenCalledWith(undo);
    await waitFor(() => expect(screen.getByText("Posting s2")).toBeInTheDocument());
  });

  it("runs now on request", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole("button", { name: "Run all now" }));
    expect(runAgentNow).toHaveBeenCalledWith({});
    expect(screen.getByRole("button", { name: "Running…" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Starting the run…");
  });

  it("points to Settings while it's off, not set up, or out of runs for the day", () => {
    const { unmount } = open({ enabled: false, nextRun: null });
    expect(screen.getByRole("note")).toHaveTextContent("The job agent is off. Turn it on in Settings → Job agent. What it found before is still here.");
    expect(screen.getByRole("link", { name: "Turn it on in Settings → Job agent" })).toHaveAttribute("href", "/settings?section=agent");
    expect(screen.getByText("Next run").nextElementSibling).toHaveTextContent("Off");
    unmount();

    const second = open({ setupProblem: "Choose a job source in Settings → Job search first.", setupSection: "jobs" });
    expect(screen.getByRole("note")).toHaveTextContent("Choose a job source. Go to Settings → Job search");
    expect(screen.getByRole("link", { name: "Go to Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
    second.unmount();

    open({ limitReached: true });
    expect(screen.getByRole("note")).toHaveTextContent("The whole batch needs more source requests than are available.");
  });

  it("links missing Jev credentials to the scoring settings", () => {
    open({ setupProblem: "Enter your TypeSafe key in Settings → Scoring first.", setupSection: "scoring" });
    expect(screen.getByRole("link", { name: "Go to Settings → Scoring" })).toHaveAttribute("href", "/settings?section=scoring");
  });

  it("says when there's nothing yet", () => {
    open({ drafts: [], scored: [], belowMinimum: [], lastRun: null, autoDraft: true });
    expect(screen.getByText("No drafts yet. After a run, the best new postings get a draft here.")).toBeInTheDocument();
    expect(screen.getByText("Nothing waiting yet. A run puts the postings that fit you best here.")).toBeInTheDocument();
    expect(screen.getByText("Last run").nextElementSibling).toHaveTextContent("Not yet");
  });
});
