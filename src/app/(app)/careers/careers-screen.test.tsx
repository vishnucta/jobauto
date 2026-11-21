import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { EmployerView } from "@/lib/careers/store-types";

import { addEmployer, checkCareers, deleteEmployer, switchEmployer } from "./actions";
import { CareersScreen } from "./careers-screen";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
const jobs = vi.hoisted(() => ({ onChange: null as null | ((job: unknown) => void) }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => null }));
vi.mock("next/link", () => ({ default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} /> }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean; error?: string }) => result }));
vi.mock("@/hooks/use-job", () => ({
  useJob: (id: string | null, _revision: number, onChange: (job: unknown) => void) => {
    jobs.onChange = id ? onChange : null;
    return id ? { id, status: "RUNNING", step: "Reading Acme's careers page" } : null;
  },
}));
vi.mock("./actions", () => ({ addEmployer: vi.fn(), saveEmployer: vi.fn(), switchEmployer: vi.fn(), deleteEmployer: vi.fn(), checkCareers: vi.fn() }));

const employer = (extra: Partial<EmployerView> = {}): EmployerView => ({
  id: "acme",
  name: "Acme",
  careersUrl: "https://acme.jobs.personio.de",
  ats: "personio",
  keywords: "Reporting, Meldewesen",
  places: "Hamburg",
  enabled: true,
  notes: "",
  lastCheckedAt: "2026-11-13T06:00:00.000Z",
  lastMatched: 3,
  lastNew: 1,
  problem: null,
  ...extra,
});

const open = (employers: EmployerView[] = [employer()]) =>
  render(<CareersScreen employers={employers} counts={{ recruiters: 2, employers: employers.length }} suggestedWords="Regulatory Reporting, EMIR" today="2026-11-13T12:00:00.000Z" timeZone="UTC" />);

beforeEach(() => vi.clearAllMocks());

describe("Careers pages", () => {
  it("sits under Positions, and shows each page followed with what its last check found", () => {
    open();
    expect(screen.getByRole("heading", { level: 1, name: "Careers pages" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Positions" })).toHaveAttribute("href", "/jobs");
    const links = within(screen.getByRole("navigation", { name: "Also in Find work" })).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["Recruiters2", "/recruiters"]]);
    const card = screen.getByRole("listitem", { name: "Acme" });
    expect(card).toHaveTextContent("Personio · https://acme.jobs.personio.de");
    expect(card).toHaveTextContent("Titles with Reporting, Meldewesen in Hamburg");
    expect(card).toHaveTextContent(/Checked .*: 3 matching jobs, 1 new/);
    // Positions through its Portal filter: what careers pages added.
    expect(within(card).getByRole("link", { name: "See what it found" })).toHaveAttribute("href", "/jobs?portal=CAREERS");
  });

  it("says why a page couldn't be read", () => {
    open([employer({ problem: "The job system doesn't know this careers page. Check its address." })]);
    expect(screen.getByRole("note")).toHaveTextContent("The job system doesn't know this careers page.");
  });

  it("follows an employer, starting from the profile's search words", async () => {
    vi.mocked(addEmployer).mockResolvedValue({ ok: true, data: employer({ id: "nord", name: "Nordbank", lastCheckedAt: null, lastMatched: 0, lastNew: 0 }) });
    open([]);
    expect(screen.getByLabelText("Words in the title")).toHaveValue("Regulatory Reporting, EMIR");
    await userEvent.type(screen.getByLabelText("Careers page"), "https://nordbank.wd3.myworkdayjobs.com/Careers");
    await userEvent.click(screen.getByRole("button", { name: "Follow" }));
    expect(addEmployer).toHaveBeenCalledWith({ name: "", careersUrl: "https://nordbank.wd3.myworkdayjobs.com/Careers", keywords: "Regulatory Reporting, EMIR", places: "" });
    expect(screen.getByRole("listitem", { name: "Nordbank" })).toHaveTextContent("Not checked yet");
  });

  it("checks every page now, shows the step, and offers the jobs it added", async () => {
    vi.mocked(checkCareers).mockResolvedValue({ ok: true, data: { jobId: "job-1", reused: false } });
    open();
    await userEvent.click(screen.getByRole("button", { name: "Check all now" }));
    expect(checkCareers).toHaveBeenCalledWith({});
    expect(screen.getByRole("button", { name: "Reading Acme's careers page" })).toBeInTheDocument();
    act(() => jobs.onChange!({ id: "job-1", status: "DONE", result: { checked: 1, added: 2, searchId: "s1", problems: [], message: "2 new jobs added to Positions from 1 careers page." } }));
    expect(toast).toHaveBeenCalledWith("2 new jobs added to Positions from 1 careers page.", { action: expect.objectContaining({ label: "Show them" }) });
    expect(router.refresh).toHaveBeenCalled();
    // Show them opens Positions on what that check added.
    vi.mocked(toast).mock.calls[0][1]!.action!.onClick();
    expect(router.push).toHaveBeenCalledWith("/jobs?found=s1");
  });

  it("turns a page off, and stops following one after asking", async () => {
    vi.mocked(switchEmployer).mockResolvedValue({ ok: true, data: employer({ enabled: false }) });
    vi.mocked(deleteEmployer).mockResolvedValue({ ok: true, data: null });
    open();
    await userEvent.click(screen.getByRole("switch", { name: "Check Acme each morning" }));
    expect(switchEmployer).toHaveBeenCalledWith({ id: "acme", enabled: false });
    await userEvent.click(screen.getByRole("button", { name: "Stop following" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Stop following" }));
    expect(deleteEmployer).toHaveBeenCalledWith({ id: "acme" });
    expect(screen.queryByRole("listitem", { name: "Acme" })).not.toBeInTheDocument();
  });
});
