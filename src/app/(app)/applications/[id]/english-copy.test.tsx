import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readInEnglish } from "./english-copy-actions";
import { EnglishCopy } from "./english-copy";

const jobs = vi.hoisted(() => ({ onChange: null as null | ((job: unknown) => void) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("@/hooks/use-job", () => ({
  useJob: (id: string | null, _revision: number, onChange: (job: unknown) => void) => {
    if (id) jobs.onChange = onChange;
    return id ? { id, status: "RUNNING", step: "Writing it in English" } : null;
  },
}));
vi.mock("./english-copy-actions", () => ({ readInEnglish: vi.fn(async () => ({ ok: true, data: { jobId: "job-1" } })) }));

beforeEach(() => vi.clearAllMocks());

describe("Read in English", () => {
  it("writes the document in English and shows it to read, once, then again without asking", async () => {
    render(<EnglishCopy applicationId="app-1" kind="COVER_LETTER" what="cover letter" />);
    await userEvent.click(screen.getByRole("button", { name: "Read in English" }));
    expect(readInEnglish).toHaveBeenCalledWith({ id: "app-1", kind: "COVER_LETTER" });
    expect(screen.getByRole("button", { name: "Writing it in English" })).toBeInTheDocument();
    act(() => jobs.onChange!({ id: "job-1", status: "DONE", result: { parts: [{ label: "Opening", text: "I read your posting with great interest." }] } }));
    const dialog = screen.getByRole("dialog", { name: "Your cover letter in English" });
    expect(dialog).toHaveTextContent("It isn't saved in the cover letter, and it isn't sent.");
    expect(dialog).toHaveTextContent("I read your posting with great interest.");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Read in English" }));
    expect(readInEnglish).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
