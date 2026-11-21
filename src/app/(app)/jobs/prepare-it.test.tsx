import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { PrepareApplicationResult } from "@/lib/jobs/prepare-application-types";
import type { JobView } from "@/lib/jobs/runner";
import { DEFAULT_FILTERS, type PostingState, type ShownPosting } from "@/lib/job-search/search";
import type { Person } from "@/lib/network";

import { loadLibraryPage, prepareApplication } from "./actions";
import { PostingResults } from "./posting-results";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => null, useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => (result.ok ? result : (toast(result.error!), result)) }));
vi.mock("../agent/actions", () => ({ prepareAgentDraft: vi.fn() }));
vi.mock("../recruiters/actions", () => ({ askForReferral: vi.fn() }));
vi.mock("./actions", () => ({
  startApplicationFrom: vi.fn(),
  loadLibraryPage: vi.fn(),
  markPostingsSeen: vi.fn(),
  loadFullText: vi.fn(),
  savePostingForLater: vi.fn(),
  unsavePosting: vi.fn(),
  dismissFoundPosting: vi.fn(),
  restorePosting: vi.fn(),
  splitSameJob: vi.fn(),
  startScoringPosting: vi.fn(),
  prepareApplication: vi.fn(async () => ({ ok: true, data: { postingId: "row", jobId: "prepare-job", applicationId: null } })),
}));
// The preparing job, as a test moves it along.
const jobs = vi.hoisted(() => ({ listeners: new Map<string, (job: JobView<PrepareApplicationResult>) => void>() }));
vi.mock("@/hooks/use-job", () => ({
  useJob: (id: string | null, _revision: number, onChange: (job: JobView<PrepareApplicationResult>) => void) => {
    if (id) jobs.listeners.set(id, onChange);
    return null;
  },
}));
const move = (job: Partial<JobView<PrepareApplicationResult>>) =>
  jobs.listeners.get("prepare-job")!({ id: "prepare-job", type: "prepare-application", status: "RUNNING", step: null, error: null, result: null, ...job });

const state: PostingState = {
  postingId: "row",
  new: false,
  saved: true,
  dismissed: false,
  applicationId: null,
  score: null,
  scores: [],
  foundOn: [{ portal: "JSEARCH", url: "" }],
  archived: false,
  stillListedAt: null,
  agentSearches: [],
  addedBy: [],
  agent: null,
};
const posting = (id = "a", change: Partial<PostingState> = {}, company = "Ledgerly"): ShownPosting => ({
  source: "JSEARCH",
  externalId: id,
  title: `Regulatory Reporting Analyst ${id}`,
  company,
  place: "Frankfurt",
  remote: false,
  salary: "",
  postedAt: null,
  url: `https://jobs.example/${id}`,
  via: "",
  description: "The whole posting.",
  complete: true,
  state: { ...state, ...change },
});
const filters = { ...DEFAULT_FILTERS, show: "saved" as const };
const open = (postings: ShownPosting[], { canPrepare = true, network = {}, more = false }: { canPrepare?: boolean; network?: Record<string, Person[]>; more?: boolean } = {}) =>
  render(
    <PostingResults postings={postings} filters={filters} total={postings.length} more={more} empty="Nothing saved yet." today="2026-11-20T10:00:00.000Z" canPrepare={canPrepare} network={network} />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  jobs.listeners.clear();
});

describe("Prepare it for me (jobauto fork)", () => {
  it("prepares the application in the background, shows the step, and opens it when ready", async () => {
    const user = userEvent.setup();
    open([posting()]);
    // Step by step is still there, beside it.
    expect(screen.getByRole("button", { name: "Step by step →" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare it for me" }));
    expect(prepareApplication).toHaveBeenCalledWith({ posting: expect.not.objectContaining({ state: expect.anything() }) });

    await waitFor(() => expect(jobs.listeners.has("prepare-job")).toBe(true));
    move({ step: "Writing the draft for Ledgerly" });
    expect(await screen.findByRole("button", { name: "Writing the draft for Ledgerly" })).toHaveAttribute("aria-disabled", "true");
    move({ status: "DONE", result: { applicationId: "app-1", route: "email" } });

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Ready to read: Regulatory Reporting Analyst a.", expect.anything()));
    const [, options] = vi.mocked(toast).mock.calls.at(-1)!;
    (options as { action: { onClick: () => void } }).action.onClick();
    expect(router.push).toHaveBeenCalledWith("/applications/app-1");
    // Now it has one: a link to it instead of the buttons.
    expect(screen.getByRole("link", { name: "Open the application" })).toHaveAttribute("href", "/applications/app-1");
    expect(screen.queryByRole("button", { name: "Prepare it for me" })).not.toBeInTheDocument();
  });

  it("says why when it fails, and can be tried again", async () => {
    const user = userEvent.setup();
    open([posting()]);
    await user.click(screen.getByRole("button", { name: "Prepare it for me" }));
    await waitFor(() => expect(jobs.listeners.has("prepare-job")).toBe(true));
    move({ status: "FAILED", error: "The AI provider didn't answer." });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("The AI provider didn't answer."));
    expect(screen.getByRole("button", { name: "Prepare it for me" })).not.toHaveAttribute("aria-disabled");
  });

  it("isn't offered without an AI model of Dossier's own, nor for a posting with an application", () => {
    const { unmount } = open([posting()], { canPrepare: false });
    expect(screen.queryByRole("button", { name: "Prepare it for me" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start application →" })).toBeInTheDocument();
    unmount();
    open([posting("a", { applicationId: "app-1" })]);
    expect(screen.queryByRole("button", { name: "Prepare it for me" })).not.toBeInTheDocument();
  });

  it("leaves a posting the job agent scored to the agent's Prepare draft, so it gets one draft", () => {
    open([posting("a", { agent: { candidateId: "cand-1", status: "SCORED", applicationId: null } })]);
    expect(screen.getByRole("button", { name: "Prepare draft" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Prepare it for me" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start application →" })).toBeInTheDocument();
  });
});

describe("who she knows at the employer (jobauto fork)", () => {
  const person: Person = { id: "c1", name: "Erika Mustermann", position: "Head of Reporting", company: "Ledgerly GmbH", url: "" };

  it("names them on the posting, and on postings Show more brings", async () => {
    const user = userEvent.setup();
    vi.mocked(loadLibraryPage).mockResolvedValue({ ok: true, data: { postings: [posting("b", {}, "Northwind")], more: false, network: { Northwind: [{ ...person, id: "c2", company: "Northwind" }] } } });
    open([posting("a")], { network: { Ledgerly: [person] }, more: true });
    expect(screen.getByRole("note", { name: "People you know here" })).toHaveTextContent("You know someone here: Erika Mustermann (Head of Reporting)");

    await user.click(screen.getByRole("button", { name: "Show more" }));
    await user.click(within(screen.getByRole("list", { name: "Postings" })).getByRole("button", { name: /Analyst b/ }));
    expect(screen.getByRole("note", { name: "People you know here" })).toBeInTheDocument();
  });

  it("says nothing where she knows nobody", () => {
    open([posting("a")]);
    expect(screen.queryByRole("note", { name: "People you know here" })).not.toBeInTheDocument();
  });
});
