import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { prepareAgentDraft } from "./agent/actions";
import { TodayCard } from "./today-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./agent/actions", () => ({ prepareAgentDraft: vi.fn(async () => ({ ok: true, data: { jobId: "job-1", applicationId: null } })) }));
vi.mock("@/hooks/use-job", () => ({ useJob: () => ({ step: "Writing your cover letter" }) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

describe("Today's three", () => {
  it("links her draft and the agent's, and prepares a match in one click", async () => {
    const user = userEvent.setup();
    render(
      <TodayCard
        items={[
          { kind: "finish", applicationId: "a1", title: "Analyst", company: "Ledgerly" },
          { kind: "review", applicationId: "a2", title: "Regulatory Reporting Analyst", company: "Berenberg", score: 84 },
          { kind: "prepare", candidateId: "c1", title: "Middle Office Specialist", company: "Warburg", score: 78, url: "https://jobs.example/1", jobId: null },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Today's three" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Finish" })).toHaveAttribute("href", "/applications/a1");
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/applications/a2");
    expect(screen.getByText(/The agent's draft: read it and send it · 84 of 100/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare" }));
    expect(prepareAgentDraft).toHaveBeenCalledWith({ candidateId: "c1" });
    expect(await screen.findByRole("button", { name: "Writing…" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Writing your cover letter");
  });

  it("points to the agent and Find jobs when nothing waits", () => {
    render(<TodayCard items={[]} />);
    expect(screen.getByText(/Nothing is waiting/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the job agent" })).toHaveAttribute("href", "/agent");
  });
});
