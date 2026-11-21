import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUILT_IN_THEMES } from "@/lib/themes";
import type { WorkSample } from "@/lib/work-sample";

import { putWorkSampleInMappe, writeWorkSample } from "./work-sample-actions";
import { WorkSampleTab } from "./work-sample-tab";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const jobs = vi.hoisted(() => ({ onChange: null as null | ((job: unknown) => void) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("@/hooks/use-job", () => ({
  useJob: (id: string | null, _revision: number, onChange: (job: unknown) => void) => {
    if (id) jobs.onChange = onChange;
    return id ? { id, status: "RUNNING", step: "Writing your first 90 days" } : null;
  },
}));
vi.mock("./work-sample-actions", () => ({
  writeWorkSample: vi.fn(async () => ({ ok: true, data: { jobId: "job-1", reused: false } })),
  putWorkSampleInMappe: vi.fn(async ({ inMappe }: { inMappe: boolean }) => ({ ok: true, data: { inMappe } })),
}));

const sample: WorkSample = {
  title: "My first 90 days as Regulatory Reporting Analyst at Acme",
  situation: "As I read the posting, Acme is moving its EMIR reporting in-house.",
  phases: [{ heading: "Days 1–30: Understand", steps: ["Map every report and its deadline"] }],
  proof: ["At a broker, I ran EMIR and MiFIR transaction reporting."],
  closing: "I'd be glad to talk the plan through.",
  unverified: [],
  inMappe: false,
};
const props = { applicationId: "app-1", aiReady: true, theme: BUILT_IN_THEMES[0], name: "Erika Mustermann", paper: "A4" as const, language: "English" };

beforeEach(() => vi.clearAllMocks());

describe("Work sample (jobauto fork)", () => {
  it("offers to write it, and follows the writing", async () => {
    render(<WorkSampleTab {...props} data={{ sample: null, jobId: null }} />);
    await userEvent.click(screen.getByRole("button", { name: "Write my first 90 days" }));
    expect(writeWorkSample).toHaveBeenCalledWith({ id: "app-1" });
    expect(screen.getByRole("button", { name: "Writing your first 90 days" })).toBeInTheDocument();
    act(() => jobs.onChange!({ id: "job-1", status: "DONE" }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the page, and puts it in the Bewerbungsmappe on request", async () => {
    render(<WorkSampleTab {...props} data={{ sample, jobId: null }} />);
    const page = screen.getByRole("article", { name: "Work sample" });
    expect(page).toHaveTextContent("My first 90 days as Regulatory Reporting Analyst at Acme");
    expect(page).toHaveTextContent("Map every report and its deadline");
    expect(page).toHaveTextContent("Where I've done this before");
    await userEvent.click(screen.getByRole("switch", { name: "In the Bewerbungsmappe" }));
    expect(putWorkSampleInMappe).toHaveBeenCalledWith({ id: "app-1", inMappe: true });
  });
});
