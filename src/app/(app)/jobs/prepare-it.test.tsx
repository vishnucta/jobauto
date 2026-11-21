import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { PrepareApplicationResult } from "@/lib/jobs/prepare-application-types";
import type { JobView } from "@/lib/jobs/runner";
import type { ShownPosting } from "@/lib/job-search/search";

import { prepareApplication } from "./actions";
import { PostingResults } from "./posting-results";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => null }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => (result.ok ? result : (toast(result.error!), result)) }));
vi.mock("./actions", () => ({
  startApplicationFrom: vi.fn(),
  showMorePostings: vi.fn(),
  loadFullText: vi.fn(),
  savePostingForLater: vi.fn(),
  unsavePosting: vi.fn(),
  dismissFoundPosting: vi.fn(),
  restorePosting: vi.fn(),
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

const posting = (applicationId: string | null = null): ShownPosting => ({
  source: "JSEARCH",
  externalId: "a",
  title: "Regulatory Reporting Analyst",
  company: "Ledgerly",
  place: "Frankfurt",
  remote: false,
  salary: "",
  postedAt: null,
  url: "https://jobs.example/a",
  via: "",
  description: "The whole posting.",
  complete: true,
  state: { postingId: "row", saved: true, dismissed: false, applicationId, score: null },
});
const open = (postings: ShownPosting[], canPrepare = true) =>
  render(<PostingResults mode="saved" postings={postings} today="2026-11-20T10:00:00.000Z" canPrepare={canPrepare} />);

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

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Ready to read: Regulatory Reporting Analyst.", expect.anything()));
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
    const { unmount } = open([posting()], false);
    expect(screen.queryByRole("button", { name: "Prepare it for me" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start application →" })).toBeInTheDocument();
    unmount();
    open([posting("app-1")]);
    expect(screen.queryByRole("button", { name: "Prepare it for me" })).not.toBeInTheDocument();
  });
});
