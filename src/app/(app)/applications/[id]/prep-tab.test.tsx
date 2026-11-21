import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallPrep } from "@/lib/call-prep";

import { prepareForCall } from "./prep-actions";
import { PrepTab } from "./prep-tab";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const jobs = vi.hoisted(() => ({ onChange: null as null | ((job: unknown) => void) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("@/hooks/use-job", () => ({
  useJob: (id: string | null, _revision: number, onChange: (job: unknown) => void) => {
    jobs.onChange = id ? onChange : null;
    return id ? { id, status: "RUNNING", step: "Preparing for the call" } : null;
  },
}));
vi.mock("./prep-actions", () => ({ prepareForCall: vi.fn() }));

const pack: CallPrep = {
  questions: [
    {
      question: { de: "Erzählen Sie etwas über sich.", en: "Tell me about yourself." },
      answer: { de: "Ich bin Financial Analyst. Ich arbeite mit EMIR und MiFIR.", en: "I'm a financial analyst working on EMIR and MiFIR reporting." },
    },
  ],
  salary: { de: "Ich stelle mir […] Euro im Jahr vor.", en: "I'm thinking of […] euros a year." },
  stories: [{ title: "Fixing rejected reports", situation: "Reports were rejected.", action: "I reconciled them.", result: "They were accepted." }],
  toAsk: [{ de: "Wie sieht das Team aus?", en: "What is the team like?" }],
  gaps: ["What is your notice period?"],
  unverified: [],
};

beforeEach(() => vi.clearAllMocks());

describe("Call prep", () => {
  it("offers to prepare the pack, with the sentence for when German runs out", async () => {
    vi.mocked(prepareForCall).mockResolvedValue({ ok: true, data: { jobId: "job-1", reused: false } });
    render(<PrepTab applicationId="app-1" data={{ pack: null, jobId: null }} aiReady company="Acme" />);
    expect(screen.getByRole("region", { name: "When German runs out" })).toHaveTextContent("Können wir bitte auf Englisch weitermachen?");
    await userEvent.click(screen.getByRole("button", { name: "Prepare for the call" }));
    expect(prepareForCall).toHaveBeenCalledWith({ id: "app-1" });
    expect(screen.getByRole("button", { name: "Preparing for the call" })).toBeInTheDocument();
    act(() => jobs.onChange!({ id: "job-1", status: "DONE" }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says to set up an AI provider first when there's none", () => {
    render(<PrepTab applicationId="app-1" data={{ pack: null, jobId: null }} aiReady={false} company="" />);
    expect(screen.queryByRole("button", { name: "Prepare for the call" })).not.toBeInTheDocument();
    expect(screen.getByText("Set up an AI provider in Settings → AI provider first.")).toBeInTheDocument();
  });

  it("shows the pack: what to decide first, each answer in German with the English, salary, stories and questions to ask", () => {
    render(<PrepTab applicationId="app-1" data={{ pack, jobId: null }} aiReady company="Acme" />);
    const article = screen.getByRole("article", { name: "Call prep" });
    expect(within(article).getByRole("heading", { name: "First call with Acme" })).toBeInTheDocument();
    expect(within(article).getByRole("region", { name: "Decide before the call" })).toHaveTextContent("What is your notice period?");
    expect(article).toHaveTextContent("Ich bin Financial Analyst. Ich arbeite mit EMIR und MiFIR.");
    expect(article).toHaveTextContent("I'm a financial analyst working on EMIR and MiFIR reporting.");
    expect(within(article).getByRole("region", { name: "Salary" })).toHaveTextContent("Ich stelle mir […] Euro im Jahr vor.");
    expect(article).toHaveTextContent("Fixing rejected reports");
    expect(article).toHaveTextContent("Wie sieht das Team aus?");
  });

  it("lists the sentences to check, each whole (jobauto fork)", () => {
    const sentences = ["I have worked in Hamburg for 3 years.", "I lead a team of 5."];
    render(<PrepTab applicationId="app-1" data={{ pack: { ...pack, unverified: sentences }, jobId: null }} aiReady company="Acme" />);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Check these against your profile before you say them:");
    expect(within(note).getAllByRole("listitem").map((item) => item.textContent)).toEqual(sentences);
  });

  it("practises one question at a time, with the answer on request", async () => {
    render(<PrepTab applicationId="app-1" data={{ pack, jobId: null }} aiReady company="Acme" />);
    await userEvent.click(screen.getByRole("button", { name: "Practise out loud" }));
    const practice = screen.getByRole("region", { name: "Practice" });
    expect(practice).toHaveTextContent("Question 1 of 2");
    expect(practice).toHaveTextContent("Erzählen Sie etwas über sich.");
    expect(practice).not.toHaveTextContent("Ich bin Financial Analyst.");
    await userEvent.click(within(practice).getByRole("button", { name: "Show my answer" }));
    expect(practice).toHaveTextContent("Ich bin Financial Analyst.");
    await userEvent.click(within(practice).getByRole("button", { name: "Next →" }));
    // The last question is always the sentence for when German runs out.
    expect(practice).toHaveTextContent("Und wenn Ihr Deutsch nicht reicht?");
  });
});
