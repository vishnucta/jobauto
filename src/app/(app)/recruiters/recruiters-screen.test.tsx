import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { OutreachFacts, RecruiterView } from "@/lib/recruiters/types";

import { addRecruiter, addSuggestedRecruiters, deleteRecruiter, moveRecruiter, saveRecruiter, snoozeFollowUp } from "./actions";
import { RecruitersScreen } from "./recruiters-screen";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/recruiters" }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("@/components/documents/download-pdf-button", () => ({
  DownloadPdfButton: ({ children, href }: { children: string; href: string }) => (
    <button type="button" data-href={href}>
      {children}
    </button>
  ),
}));
vi.mock("./actions", () => ({
  addRecruiter: vi.fn(),
  addSuggestedRecruiters: vi.fn(),
  deleteRecruiter: vi.fn(),
  moveRecruiter: vi.fn(),
  saveRecruiter: vi.fn(),
  snoozeFollowUp: vi.fn(),
}));

const TODAY = "2026-11-10T09:00:00.000Z";
const days = (count: number) => new Date(Date.parse(TODAY) + count * 86_400_000).toISOString();

const recruiter = (patch: Partial<RecruiterView>): RecruiterView => ({
  id: "r1",
  kind: "AGENCY",
  name: "Selby Jennings",
  contactName: "",
  email: "",
  website: "",
  speciality: "Financial services",
  relation: "",
  notes: "",
  source: "you",
  status: "NOT_CONTACTED",
  contactedAt: null,
  followUpAt: null,
  createdAt: days(-20),
  events: [{ id: "e1", text: "Added", at: days(-20) }],
  ...patch,
});

const facts: OutreachFacts = { name: "Erika Mustermann", headline: "Financial Analyst", city: "Hamburg", languages: [{ name: "English", level: "Fluent (C2)" }] };

const due = recruiter({ id: "due", name: "Arkwright", status: "CONTACTED", contactedAt: days(-9), followUpAt: days(-2), email: "jobs@arkwright.example" });
const fresh = recruiter({ id: "fresh", name: "Hays", speciality: "All fields", source: "found in search" });
const replied = recruiter({ id: "replied", name: "Michael Page", status: "REPLIED", contactedAt: days(-4) });
const all = [fresh, replied, due];

const counts = { recruiters: 3, employers: 2 };
const renderScreen = (recruiters: RecruiterView[] = all, profileId?: string) =>
  render(<RecruitersScreen recruiters={recruiters} facts={facts} profileId={profileId} counts={counts} today={TODAY} />);
const list = () => screen.getByRole("region", { name: "Your list" });
const rows = () => within(list()).getAllByRole("listitem").map((item) => within(item).getAllByRole("button")[0].textContent);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(moveRecruiter).mockResolvedValue({ ok: true, data: due });
  vi.mocked(snoozeFollowUp).mockResolvedValue({ ok: true, data: due });
  vi.mocked(saveRecruiter).mockResolvedValue({ ok: true, data: due });
  vi.mocked(addRecruiter).mockResolvedValue({ ok: true, data: recruiter({ id: "new", name: "Randstad" }) });
  vi.mocked(deleteRecruiter).mockResolvedValue({ ok: true, data: null, toast: "Recruiter removed." });
  vi.mocked(addSuggestedRecruiters).mockResolvedValue({ ok: true, data: { added: 4 }, toast: "Added 4 agencies." });
});

describe("the agency round, as the list's To contact view (jobauto fork)", () => {
  it("offers the Kurzprofil, each one still to write to with I wrote to them, and its message, brief included", async () => {
    const briefed: OutreachFacts = { ...facts, brief: { targets: ["Financial Analyst"], mobility: "anywhere in Germany", start: "sofort", salary: "62.000 €" } };
    render(<RecruitersScreen recruiters={all} facts={briefed} counts={counts} today={TODAY} />);
    // No second list of the same agencies above the list.
    expect(screen.queryByRole("region", { name: /agencies to write to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kurzprofil (PDF)" })).not.toBeInTheDocument();

    await userEvent.click(within(list()).getByRole("button", { name: /^To contact/ }));
    expect(within(list()).getByRole("note")).toHaveTextContent("one-page Kurzprofil");
    expect(within(list()).getByRole("button", { name: "Kurzprofil (PDF)" })).toHaveAttribute("data-href", "/api/pdf?doc=kurzprofil");
    expect(rows()).toEqual([expect.stringContaining("Hays")]);
    await userEvent.click(within(list()).getByRole("button", { name: "I wrote to them (Hays)" }));
    expect(moveRecruiter).toHaveBeenCalledWith({ id: "fresh", status: "CONTACTED" });
    expect(router.refresh).toHaveBeenCalled();

    // Its message, with the Kurzprofil beside the resume.
    await userEvent.click(within(list()).getByRole("button", { name: /^Hays/ }));
    const gmail = new URL(screen.getByRole("link", { name: "Open in Gmail" }).getAttribute("href")!);
    expect(gmail.searchParams.get("body")).toContain("I am looking for roles as Financial Analyst (anywhere in Germany). Available sofort; salary expectation 62.000 €.");
    expect(screen.getAllByRole("button", { name: "Kurzprofil (PDF)" })).toHaveLength(2);
  });

  it("offers the Kurzprofil of the profile the messages are written from, and none on the other views", async () => {
    renderScreen(all, "profile-2");
    await userEvent.click(within(list()).getByRole("button", { name: /^Waiting/ }));
    expect(within(list()).queryByRole("button", { name: /I wrote to them/ })).not.toBeInTheDocument();
    await userEvent.click(within(list()).getByRole("button", { name: /^To contact/ }));
    expect(within(list()).getByRole("button", { name: "Kurzprofil (PDF)" })).toHaveAttribute("data-href", "/api/pdf?doc=kurzprofil&profile=profile-2");
  });
});

describe("the Recruiters screen", () => {
  it("sits under Positions, with a link to Careers pages beside it", () => {
    renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: "Recruiters" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", { name: "Positions" })).toHaveAttribute("href", "/jobs");
    const links = within(screen.getByRole("navigation", { name: "Also in Find work" })).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["Careers pages2", "/careers"]]);
  });

  it("offers the Base resume of the profile the message is written from", async () => {
    renderScreen(all, "profile-2");
    await userEvent.click(within(list()).getByRole("button", { name: /Arkwright/ }));
    expect(screen.getByRole("button", { name: "Download your resume" })).toHaveAttribute("data-href", "/api/pdf?doc=base&profile=profile-2");
  });

  it("counts the list and puts the follow-up that is due first", () => {
    renderScreen();
    expect(screen.getByText("on your list").previousElementSibling).toHaveTextContent("3");
    expect(screen.getByText("contacted").previousElementSibling).toHaveTextContent("2");
    expect(screen.getByText("replied").previousElementSibling).toHaveTextContent("1");
    expect(screen.getByText("follow-ups due").previousElementSibling).toHaveTextContent("1");
    expect(rows()).toEqual([expect.stringContaining("Arkwright"), expect.stringContaining("Hays"), expect.stringContaining("Michael Page")]);
    const first = within(list()).getAllByRole("listitem")[0];
    expect(first).toHaveTextContent("Follow-up due");
    expect(first).toHaveTextContent("Contacted 9 days ago · follow-up due");
  });

  it("says where an agency was found, apart from the ones the user added", () => {
    renderScreen();
    const items = within(list()).getAllByRole("listitem");
    expect(items.find((item) => item.textContent?.includes("Hays"))).toHaveTextContent("All fields · Found in a search");
    expect(items.find((item) => item.textContent?.includes("Arkwright"))).not.toHaveTextContent("Found in a search");
  });

  it("filters by where each conversation stands", async () => {
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: /^Replied/ }));
    expect(rows()).toEqual([expect.stringContaining("Michael Page")]);
    await userEvent.click(screen.getByRole("button", { name: /^Follow-up due/ }));
    expect(rows()).toEqual([expect.stringContaining("Arkwright")]);
    await userEvent.click(screen.getByRole("button", { name: /^To contact/ }));
    expect(rows()).toEqual([expect.stringContaining("Hays")]);
  });

  it("drafts a follow-up for one being waited on, with Gmail opening on its address, and moves it on only when told", async () => {
    renderScreen();
    await userEvent.click(within(list()).getByRole("button", { name: /Arkwright/ }));
    const detail = screen.getByRole("region", { name: "Arkwright" });
    expect(within(detail).getByRole("heading", { name: "Follow-up, ready to review" })).toBeInTheDocument();
    expect(within(detail).getByLabelText("Subject")).toHaveValue("Following up: Financial Analyst");
    expect((within(detail).getByLabelText("Message") as HTMLTextAreaElement).value).toContain("I wrote to you on 1 November");

    const gmail = new URL(within(detail).getByRole("link", { name: "Open in Gmail" }).getAttribute("href")!);
    expect(gmail.searchParams.get("to")).toBe("jobs@arkwright.example");
    expect(gmail.searchParams.get("su")).toBe("Following up: Financial Analyst");
    // Opening the draft marks nothing: only the user's own word does.
    expect(moveRecruiter).not.toHaveBeenCalled();

    await userEvent.click(within(detail).getByRole("button", { name: "They replied" }));
    expect(moveRecruiter).toHaveBeenCalledWith({ id: "due", status: "REPLIED" });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("uses what the user changed in the message for Gmail", async () => {
    renderScreen();
    await userEvent.click(within(list()).getByRole("button", { name: /Arkwright/ }));
    const subject = screen.getByLabelText("Subject");
    await userEvent.clear(subject);
    await userEvent.type(subject, "Hello again");
    expect(new URL(screen.getByRole("link", { name: "Open in Gmail" }).getAttribute("href")!).searchParams.get("su")).toBe("Hello again");
  });

  it("drafts a first message for one not written to, and says an address is missing", async () => {
    renderScreen();
    await userEvent.click(within(list()).getByRole("button", { name: /Hays/ }));
    const detail = screen.getByRole("region", { name: "Hays" });
    expect(within(detail).getByRole("heading", { name: "First message, ready to review" })).toBeInTheDocument();
    expect((within(detail).getByLabelText("Message") as HTMLTextAreaElement).value).toContain("My languages: English (Fluent (C2)).");
    expect(within(detail).getByText(/no email for them yet/)).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole("button", { name: "I wrote to them" }));
    expect(moveRecruiter).toHaveBeenCalledWith({ id: "fresh", status: "CONTACTED" });
  });

  it("snoozes a follow-up, and offers no message for one that replied", async () => {
    renderScreen();
    await userEvent.click(within(list()).getByRole("button", { name: /Arkwright/ }));
    await userEvent.click(screen.getByRole("button", { name: "Snooze 3 days" }));
    expect(snoozeFollowUp).toHaveBeenCalledWith({ id: "due" });

    await userEvent.click(within(list()).getByRole("button", { name: /Michael Page/ }));
    expect(screen.queryByRole("heading", { name: /ready to review/ })).not.toBeInTheDocument();
    expect(screen.getByText(/They replied\. Write back from your own mail/)).toBeInTheDocument();
  });

  it("adds a recruiter from the form, showing what is wrong with a field", async () => {
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: "Add a recruiter" }));
    const form = screen.getByRole("form", { name: "New recruiter" });
    vi.mocked(addRecruiter).mockResolvedValueOnce({ ok: false, error: "Some details aren't valid. Check the highlighted fields.", fieldErrors: { name: ["Give the agency, recruiter or employer a name."] } });
    await userEvent.click(within(form).getByRole("button", { name: "Add recruiter" }));
    expect(await within(form).findByText("Give the agency, recruiter or employer a name.")).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("Some details aren't valid. Check the highlighted fields.");

    await userEvent.type(within(form).getByLabelText("Agency or recruiter"), "Randstad");
    await userEvent.click(within(form).getByRole("button", { name: "Add recruiter" }));
    expect(addRecruiter).toHaveBeenLastCalledWith({ kind: "AGENCY", name: "Randstad", contactName: "", email: "", website: "", speciality: "", relation: "", notes: "" });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it("adds someone who could refer her, with how she knows them", async () => {
    renderScreen();
    await userEvent.click(screen.getByRole("button", { name: "Add a recruiter" }));
    const form = screen.getByRole("form", { name: "New recruiter" });
    await userEvent.selectOptions(within(form).getByLabelText("Who"), "REFERRAL");
    expect(within(form).queryByLabelText("Agency or recruiter")).not.toBeInTheDocument();
    await userEvent.type(within(form).getByLabelText("Employer"), "Acme Bank");
    await userEvent.type(within(form).getByLabelText("Their name"), "Sam");
    await userEvent.type(within(form).getByLabelText("How you know them"), "We worked together at EY");
    await userEvent.click(within(form).getByRole("button", { name: "Add contact" }));
    expect(addRecruiter).toHaveBeenLastCalledWith({ kind: "REFERRAL", name: "Acme Bank", contactName: "Sam", email: "", website: "", speciality: "", relation: "We worked together at EY", notes: "" });
  });

  it("saves details, and removes a recruiter only after asking", async () => {
    renderScreen();
    await userEvent.click(within(list()).getByRole("button", { name: /Hays/ }));
    await userEvent.type(screen.getByLabelText("Contact person"), "Alex");
    await userEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(saveRecruiter).toHaveBeenCalledWith(expect.objectContaining({ id: "fresh", name: "Hays", contactName: "Alex" }));

    await userEvent.click(screen.getByRole("button", { name: "Remove from the list" }));
    expect(deleteRecruiter).not.toHaveBeenCalled();
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    expect(deleteRecruiter).toHaveBeenCalledWith({ id: "fresh" });
  });

  it("starts empty with the suggested agencies on offer, and hides that once they are all there", async () => {
    const { unmount } = renderScreen([]);
    expect(screen.getByText(/No recruiters yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add suggested agencies" }));
    expect(addSuggestedRecruiters).toHaveBeenCalledWith({});
    unmount();
    const names = ["Robert Walters", "Selby Jennings", "Hays", "Robert Half"];
    renderScreen(names.map((name, index) => recruiter({ id: `s${index}`, name })));
    expect(screen.queryByRole("button", { name: "Add suggested agencies" })).not.toBeInTheDocument();
  });
});
