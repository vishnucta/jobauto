import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateSettings } from "./actions";
import { FieldScoringCard } from "./field-scoring-card";

vi.mock("./actions", () => ({ updateSettings: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

beforeEach(() => vi.clearAllMocks());

describe("Settings → Scoring: postings in your field (jobauto fork, Niche first)", () => {
  it("says what is scored on its own, what never is, and that each one goes to the scoring model", () => {
    render(<FieldScoringCard perDay={5} agent={{ on: false, maxScores: 15 }} />);
    expect(screen.getByRole("heading", { name: "Postings in your field" })).toBeInTheDocument();
    expect(screen.getByLabelText("Score on their own, each day")).toHaveValue("5");
    expect(screen.getByText(/Each one sends the posting and your profile to the scoring model above\./)).toBeInTheDocument();
    expect(screen.getByText(/found in the last 7 days whose title names one of your field's words, or whose text names two\. No job portal is asked for anything\./)).toBeInTheDocument();
    expect(screen.getByText(/A posting is never scored twice\. One that needs far more German than your profile has, or that you dismissed or applied to, is left out\./)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is scored while scoring is off/)).toBeInTheDocument();
  });

  it("says how the number relates to the job agent's own, so the two never add up unseen", () => {
    const { rerender } = render(<FieldScoringCard perDay={5} agent={{ on: true, maxScores: 15 }} />);
    expect(
      screen.getByText(
        "The job agent scores up to 15 postings a run from its own searches as well. With both on, at most 20 postings a day are scored without you asking; a posting one of them scored is not scored again by the other.",
      ),
    ).toBeInTheDocument();
    rerender(<FieldScoringCard perDay={5} agent={{ on: false, maxScores: 15 }} />);
    expect(screen.getByText("The job agent is off, so these 5 are all that is scored without you asking.")).toBeInTheDocument();
  });

  it("saves a new number as it's chosen, and 0 switches it off", async () => {
    const user = userEvent.setup();
    render(<FieldScoringCard perDay={5} agent={{ on: true, maxScores: 15 }} />);
    await user.selectOptions(screen.getByLabelText("Score on their own, each day"), "0 (off)");
    expect(updateSettings).toHaveBeenCalledWith({ fieldScoresPerDay: 0 });
    expect(screen.getByText("The job agent still scores up to 15 postings a run from its own searches.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Score on their own, each day"), "Up to 10");
    expect(updateSettings).toHaveBeenLastCalledWith({ fieldScoresPerDay: 10 });
  });

  it("keeps a number that isn't one of the choices, and puts the old one back when saving fails", async () => {
    const user = userEvent.setup();
    vi.mocked(updateSettings).mockResolvedValueOnce({ ok: false, error: "Couldn't save." });
    render(<FieldScoringCard perDay={7} agent={{ on: false, maxScores: 15 }} />);
    const select = screen.getByLabelText("Score on their own, each day");
    expect(select).toHaveValue("7");
    await user.selectOptions(select, "Up to 3");
    expect(select).toHaveValue("7");
  });
});
