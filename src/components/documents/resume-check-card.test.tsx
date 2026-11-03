import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ResumeCheck } from "@/lib/resume-check";

import { ResumeCheckCard } from "./resume-check-card";

const report: ResumeCheck = {
  document: "resume",
  fileName: "Jane Doe – Ledgerly – Resume.pdf",
  pages: 2,
  maxPages: 1,
  reads: [
    { id: "text-layer", level: "ok", title: "Text reads as text", detail: "Every heading, title and bullet is in the PDF's text layer (31 checked)." },
    { id: "columns", level: "warn", title: "Two columns", detail: "Parsers that sort text by its position mix the columns.", fix: { kind: "single-column" } },
    { id: "pages", level: "warn", title: "Over the page limit", detail: "2 pages, limit 1", fix: { kind: "settings", section: "documents" } },
    { id: "photo", level: "warn", title: "Photo on the resume", detail: "Where this posting is (United Kingdom), a photo is unusual.", fix: { kind: "photo" } },
  ],
  requirements: {
    items: [
      { index: -1, requirement: "Senior Product Designer", named: false, inProfile: true, skill: null },
      { index: 0, requirement: "Strong prototyping skills in Figma", named: true, inProfile: true, skill: "Figma" },
      { index: 1, requirement: "Experience with Kubernetes", named: false, inProfile: true, skill: "Kubernetes" },
      { index: 2, requirement: "Fintech experience", named: false, inProfile: false, skill: null },
    ],
    named: 1,
    total: 3,
  },
  text: [
    { id: "characters", level: "fail", title: "Characters parsers misread", detail: "2 ligature glyphs.", fix: { kind: "clean-up" } },
    { id: "language", level: "warn", title: "Text in German under English headings and dates", fix: { kind: "language", language: "German" } },
    { id: "dates", level: "ok", title: "Dates in one style" },
  ],
  checkedAt: "2026-11-02T10:00:00.000Z",
};

const row = (text: RegExp | string) => screen.getByText(text).closest("li")!;

describe("ResumeCheckCard", () => {
  it("is a region headed ATS check, with the three groups and the pages before the file name", () => {
    render(<ResumeCheckCard report={report} onFix={vi.fn()} />);
    const card = screen.getByRole("region", { name: "ATS check" });
    expect(within(card).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Reads correctly",
      "Says what the posting asks for",
      "Clean text",
    ]);
    // When it ran, in the browser's own time, so a report left open doesn't pass for a fresh one.
    expect(within(card).getByText(/^Checked at \d\d:\d\d(\s?[AP]M)? · 2 pages · Jane Doe – Ledgerly – Resume\.pdf$/)).toBeInTheDocument();
    // The Base resume screen reads its own page count off a line ending that way.
    expect(screen.queryByText(/ · \d+ pages?$/)).not.toBeInTheDocument();
    expect(within(card).getByText("1 of 3 named")).toBeInTheDocument();
    expect(within(card).getByText("Text reads as text")).toBeInTheDocument();
    expect(within(card).getByText("Every heading, title and bullet is in the PDF's text layer (31 checked).")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/changed since this check/)).not.toBeInTheDocument();
  });

  it("offers each fix as a button, or a link to where the setting lives", async () => {
    const user = userEvent.setup();
    const onFix = vi.fn();
    render(<ResumeCheckCard report={report} onFix={onFix} />);
    await user.click(screen.getByRole("button", { name: "Use a single column" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "single-column" });
    await user.click(screen.getByRole("button", { name: "Hide the photo" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "photo" });
    await user.click(screen.getByRole("button", { name: "Clean up the text" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "clean-up" });
    await user.click(screen.getByRole("button", { name: "Set the language to German" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "language", language: "German" });
    expect(within(row("Over the page limit")).getByRole("link", { name: "Open Settings → Documents" })).toHaveAttribute("href", "/settings?section=documents");
    expect(within(row("Dates in one style")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("lists each requirement as named or not, with Add to Skills and Mention in the summary for those the profile has", async () => {
    const user = userEvent.setup();
    const onFix = vi.fn();
    render(<ResumeCheckCard report={report} onFix={onFix} />);
    expect(row("Strong prototyping skills in Figma")).toHaveTextContent("Named in the resume");
    expect(within(row("Strong prototyping skills in Figma")).queryByRole("button")).not.toBeInTheDocument();

    const kubernetes = row("Experience with Kubernetes");
    expect(kubernetes).toHaveTextContent("Not named; your profile has it as “Kubernetes”");
    await user.click(within(kubernetes).getByRole("button", { name: "Add to Skills" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "add-skill", skill: "Kubernetes" });
    await user.click(within(kubernetes).getByRole("button", { name: "Mention in the summary" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "mention", term: "Kubernetes" });

    // The job title has no spelling to add, only a mention.
    const title = row("Job title: Senior Product Designer");
    expect(within(title).getAllByRole("button").map((button) => button.textContent)).toEqual(["Mention in the summary"]);
    await user.click(within(title).getByRole("button", { name: "Mention in the summary" }));
    expect(onFix).toHaveBeenLastCalledWith({ kind: "mention", term: "Senior Product Designer" });

    // Nothing to offer for what the profile doesn't have.
    expect(row("Fintech experience")).toHaveTextContent("Not named, and not in your profile");
    expect(within(row("Fintech experience")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("leaves the requirements out when the report has none", () => {
    render(<ResumeCheckCard report={{ ...report, requirements: null }} onFix={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: "Says what the posting asks for" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("says when the resume changed since, and makes the buttons wait while a fix runs, keeping them focusable", async () => {
    const onFix = vi.fn();
    render(<ResumeCheckCard report={report} onFix={onFix} stale fixing />);
    expect(screen.getByText("The resume changed since this check — run it again.")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toBeDisabled();
      await userEvent.click(button);
    }
    expect(onFix).not.toHaveBeenCalled();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("points the base resume to the Themes panel and the profile, which hold its switches", () => {
    const base: ResumeCheck = {
      ...report,
      document: "base",
      fileName: "Jane Doe – Resume.pdf",
      pages: 1,
      requirements: null,
      reads: [
        { id: "columns", level: "warn", title: "Two columns", fix: { kind: "theme" } },
        { id: "photo", level: "warn", title: "Photo on the resume", fix: { kind: "photo" } },
      ],
      text: [{ id: "characters", level: "ok", title: "Plain characters" }],
    };
    render(<ResumeCheckCard report={base} onFix={vi.fn()} />);
    expect(screen.getByText(/^Checked at .+ · 1 page · Jane Doe – Resume\.pdf$/)).toBeInTheDocument();
    expect(row("Two columns")).toHaveTextContent("Pick a single-column theme in the Themes panel.");
    expect(within(row("Photo on the resume")).getByRole("link", { name: "Turn the photo off in your profile" })).toHaveAttribute("href", "/profile?section=basics");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
