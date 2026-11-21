import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLY_ANSWERS } from "@/lib/apply/answers";

import { saveStandardAnswers } from "./answers-actions";
import { AnswersSection } from "./answers-section";

vi.mock("./answers-actions", () => ({ saveStandardAnswers: vi.fn(async () => ({ ok: true, data: null, toast: "Saved. They're used for every application." })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

beforeEach(() => vi.clearAllMocks());

describe("Settings → Standard answers (jobauto fork)", () => {
  it("is the one place to edit them, says they're used for every application, and shows the salary guide by the salary", async () => {
    render(<AnswersSection initial={{ ...DEFAULT_APPLY_ANSWERS, confirmed: true }} salaryGuide={{ title: "Financial Analyst", text: "€54,000–€59,000 a year (middle €58,000), from 12 jobs like “Financial Analyst”" }} />);
    expect(screen.getByRole("heading", { name: "Standard answers" })).toBeInTheDocument();
    expect(screen.getByText(/^Used for every application\./)).toBeInTheDocument();
    expect(screen.getByText("Postings you've seen: €54,000–€59,000 a year (middle €58,000), from 12 jobs like “Financial Analyst”.")).toBeInTheDocument();

    const save = screen.getByRole("button", { name: "Save answers" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(screen.getByLabelText("Salary expectation"), "55.000 €");
    await userEvent.type(screen.getByLabelText(/Earliest start date/), "sofort");
    expect(screen.getByText("Not saved yet")).toBeInTheDocument();
    await userEvent.click(save);
    expect(saveStandardAnswers).toHaveBeenCalledWith({ answers: expect.objectContaining({ salary: "55.000 €", startDate: "sofort" }) });
    expect(screen.queryByText("Not saved yet")).not.toBeInTheDocument();
  });

  it("says when there's no salary guide yet, and that unsaved answers claim no work permit", () => {
    render(<AnswersSection initial={{ ...DEFAULT_APPLY_ANSWERS, confirmed: false }} salaryGuide={null} />);
    expect(screen.getByText(/don't state enough salaries for a guide yet/)).toBeInTheDocument();
    expect(screen.getByText(/letters don't claim a work permit/)).toBeInTheDocument();
  });
});
