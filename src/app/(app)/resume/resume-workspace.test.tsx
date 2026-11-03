import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { ActionResult } from "@/lib/action";
import { demoProfile } from "@/lib/demo-profile";
import type { ResumeCheck } from "@/lib/resume-check";
import { BUILT_IN_THEMES } from "@/lib/themes";

import { themeFile } from "@/lib/theme-file";

import { checkBaseResumeAts, deleteTheme, duplicateTheme, importTheme, saveTheme, setBaseTheme } from "./actions";
import { ResumeWorkspace, type ResumeWorkspaceProps } from "./resume-workspace";

vi.mock("./actions", () => ({
  setBaseTheme: vi.fn(),
  saveTheme: vi.fn(),
  duplicateTheme: vi.fn(),
  deleteTheme: vi.fn(),
  importTheme: vi.fn(),
  checkBaseResumeAts: vi.fn(),
}));
vi.mock("@/components/toast", () => {
  const toast = vi.fn();
  return {
    toast,
    toastResult: <T,>(result: ActionResult<T>) => {
      if (!result.ok) toast(result.error);
      else if (result.toast) toast(result.toast);
      return result;
    },
  };
});

const props: ResumeWorkspaceProps = {
  profile: demoProfile(),
  themes: BUILT_IN_THEMES,
  usage: {},
  baseThemeId: "modern",
  paper: "A4",
  includeReferences: false,
  maxPages: 1,
  language: null,
};

/** The theme name above the preview, next to "A4 · 1 page". */
const previewLabel = () => screen.getByText(/ · \d+ pages?$/).previousElementSibling?.textContent;

describe("ResumeWorkspace", () => {
  beforeEach(() => {
    vi.mocked(setBaseTheme).mockReset().mockResolvedValue({ ok: true, data: null });
    vi.mocked(toast).mockReset();
  });

  it("has the header, its actions and the preview in the base theme (RES-1)", () => {
    render(<ResumeWorkspace {...props} />);
    expect(screen.getByRole("heading", { level: 1, name: "Base resume" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Edit profile" })).toHaveAttribute("href", "/profile");
    expect(screen.getByRole("link", { name: "Download PDF" })).toHaveAttribute("href", "/api/pdf?doc=base");
    expect(previewLabel()).toBe("Modern");
    expect(screen.getByText("A4 · 1 page")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Resume" })).toHaveTextContent("Jane Doe");
  });

  it("points to the profile while it's empty, and only then (E11-4)", () => {
    const empty = { ...props.profile, basics: { ...props.profile.basics, name: "" }, skills: [], experience: [], projects: [], education: [] };
    const { unmount } = render(<ResumeWorkspace {...props} profile={empty} />);
    expect(screen.getByRole("note")).toHaveTextContent("Your resume fills in from your profile.");
    expect(within(screen.getByRole("note")).getByRole("link", { name: "Go to your profile" })).toHaveAttribute("href", "/profile");
    unmount();
    // A project alone is a start (PRO-13).
    const { unmount: unmountProjects } = render(<ResumeWorkspace {...props} profile={{ ...empty, projects: props.profile.projects }} />);
    expect(screen.queryByText(/fills in from your profile/)).not.toBeInTheDocument();
    unmountProjects();
    render(<ResumeWorkspace {...props} />);
    expect(screen.queryByText(/fills in from your profile/)).not.toBeInTheDocument();
  });

  it("names the paper size", () => {
    render(<ResumeWorkspace {...props} paper="LETTER" />);
    expect(screen.getByText("US Letter · 1 page")).toBeInTheDocument();
  });

  it("includes references when Settings says so", () => {
    render(<ResumeWorkspace {...props} includeReferences />);
    expect(screen.getByRole("heading", { name: "References" })).toBeInTheDocument();
  });

  it("falls back to the first theme when the base theme is missing", () => {
    render(<ResumeWorkspace {...props} baseThemeId="deleted" />);
    expect(previewLabel()).toBe("Editorial");
  });

  it("shows a picked theme right away and saves it as the base theme (RES-2)", async () => {
    render(<ResumeWorkspace {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Classic theme" }));
    expect(previewLabel()).toBe("Classic");
    expect(screen.getByRole("button", { name: "Classic theme, in use" })).toBeInTheDocument();
    expect(setBaseTheme).toHaveBeenCalledWith({ id: "classic" });
  });

  it("goes back to the saved theme when saving fails", async () => {
    vi.mocked(setBaseTheme).mockResolvedValue({ ok: false, error: "That theme doesn't exist anymore." });
    render(<ResumeWorkspace {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Classic theme" }));
    expect(await screen.findByRole("button", { name: "Modern theme, in use" })).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("That theme doesn't exist anymore.");
  });

  it("previews the draft while you customise, and discards it on Cancel (RES-3)", async () => {
    render(<ResumeWorkspace {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Customize" }));
    expect(previewLabel()).toBe("My theme");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Accent" })).getByRole("radio", { name: "Plum" }));
    const page = screen.getByRole("article", { name: "Resume" });
    expect(page.style.getPropertyValue("--accent")).toBe("#6b4f8a");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "Themes", selected: true })).toBeInTheDocument();
    expect(previewLabel()).toBe("Modern");
    expect(page.style.getPropertyValue("--accent")).toBe("#2f5d8a");
  });

  it("saves the draft as your base theme (RES-4)", async () => {
    vi.mocked(saveTheme).mockImplementation(async ({ id, ...draft }) => ({
      ok: true,
      data: { ...draft, id: id ?? "c1", builtIn: false },
      toast: `Saved “${draft.name}”. It's now your base resume theme.`,
    }));
    render(<ResumeWorkspace {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /Make your own theme/ }));
    await userEvent.clear(screen.getByLabelText("Theme name"));
    await userEvent.type(screen.getByLabelText("Theme name"), "Blue airy");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Spacing" })).getByRole("radio", { name: "Airy" }));
    await userEvent.click(screen.getByRole("button", { name: "Save theme" }));

    expect(saveTheme).toHaveBeenCalledWith(
      expect.objectContaining({ id: null, name: "Blue airy", headFont: "GEIST", density: "AIRY" }),
    );
    expect(toast).toHaveBeenCalledWith("Saved “Blue airy”. It's now your base resume theme.");
    expect(await screen.findByRole("button", { name: "Blue airy theme, in use" })).toBeInTheDocument();
    expect(previewLabel()).toBe("Blue airy");
  });

  it("keeps the draft when saving fails", async () => {
    vi.mocked(saveTheme).mockResolvedValue({ ok: false, error: "Something went wrong." });
    render(<ResumeWorkspace {...props} />);
    await userEvent.click(screen.getByRole("tab", { name: "Customize" }));
    await userEvent.click(screen.getByRole("button", { name: "Save theme" }));
    expect(toast).toHaveBeenCalledWith("Something went wrong.");
    expect(screen.getByLabelText("Theme name")).toHaveValue("My theme");
  });
});

describe("managing themes (E5-7)", () => {
  const custom = { ...BUILT_IN_THEMES[1], id: "c1", name: "Quiet green", builtIn: false };

  beforeEach(() => vi.mocked(toast).mockReset());

  it("duplicates the theme in use, which becomes the one in use", async () => {
    const user = userEvent.setup();
    vi.mocked(duplicateTheme).mockResolvedValueOnce({ ok: true, data: { ...BUILT_IN_THEMES[1], id: "c2", name: "Modern copy", builtIn: false } });
    render(<ResumeWorkspace {...props} />);
    expect(screen.getByText("In use:")).toHaveTextContent("In use: Modern");
    // Built-in themes can't be deleted.
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Duplicate Modern" }));
    expect(duplicateTheme).toHaveBeenCalledWith({ id: "modern" });
    expect(screen.getByRole("button", { name: "Modern copy theme, in use" })).toBeInTheDocument();
  });

  it("asks before deleting, says how many applications use the theme, then falls back", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteTheme).mockResolvedValueOnce({ ok: true, data: { baseThemeId: "editorial" } });
    render(<ResumeWorkspace {...props} themes={[...BUILT_IN_THEMES, custom]} baseThemeId="c1" usage={{ c1: 2 }} />);
    await user.click(screen.getByRole("button", { name: "Delete Quiet green…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete “Quiet green”?" });
    expect(dialog).toHaveTextContent("2 applications use it; their documents will use your base theme instead. Editorial becomes your base theme.");
    await user.click(within(dialog).getByRole("button", { name: "Delete theme" }));
    expect(deleteTheme).toHaveBeenCalledWith({ id: "c1" });
    expect(screen.queryByRole("button", { name: /Quiet green theme/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editorial theme, in use" })).toBeInTheDocument();
  });

  it("exports the theme in use as a file", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:theme");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("Modern.dossier-theme.json");
    });
    render(<ResumeWorkspace {...props} />);
    await user.click(screen.getByRole("button", { name: "Export Modern" }));
    expect(click).toHaveBeenCalled();
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(JSON.parse(await blob.text())).toEqual(themeFile(BUILT_IN_THEMES.find((theme) => theme.id === "modern")!));
    click.mockRestore();
  });

  it("imports a theme file, and explains one it can't use", async () => {
    const user = userEvent.setup();
    const file = themeFile({ ...BUILT_IN_THEMES[0], name: "Shared" });
    vi.mocked(importTheme).mockResolvedValueOnce({ ok: true, data: { ...BUILT_IN_THEMES[0], id: "c3", name: "Shared", builtIn: false } });
    const { container } = render(<ResumeWorkspace {...props} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    await user.upload(input, new File([JSON.stringify(file)], "Shared.dossier-theme.json", { type: "application/json" }));
    expect(importTheme).toHaveBeenCalledWith({ file });
    expect(screen.getByRole("button", { name: "Shared theme, in use" })).toBeInTheDocument();

    await user.upload(input, new File(["{\"hello\":1}"], "other.json", { type: "application/json" }));
    expect(toast).toHaveBeenCalledWith("That file isn't a Dossier theme.");
    expect(importTheme).toHaveBeenCalledTimes(1);
  });
});

describe("the ATS check", () => {
  const report: ResumeCheck = {
    document: "base",
    fileName: "Jane Doe – Resume.pdf",
    pages: 1,
    maxPages: 1,
    reads: [
      { id: "text-layer", level: "ok", title: "Text reads as text" },
      { id: "columns", level: "warn", title: "Two columns", fix: { kind: "theme" } },
      { id: "photo", level: "warn", title: "Photo on the resume", fix: { kind: "photo" } },
    ],
    requirements: null,
    text: [{ id: "characters", level: "ok", title: "Plain characters" }],
    checkedAt: "2026-11-02T10:00:00.000Z",
  };
  const button = () => screen.getByRole("button", { name: "Check for ATS" });

  beforeEach(() => {
    vi.mocked(checkBaseResumeAts).mockReset().mockResolvedValue({ ok: true, data: report });
    vi.mocked(setBaseTheme).mockReset().mockResolvedValue({ ok: true, data: null });
    vi.mocked(toast).mockReset();
  });

  it("prints the base resume and shows the report, whose fixes point to the Themes panel and the profile", async () => {
    const user = userEvent.setup();
    render(<ResumeWorkspace {...props} />);
    await user.click(button());
    expect(checkBaseResumeAts).toHaveBeenCalledWith({});
    const card = await screen.findByRole("region", { name: "ATS check" });
    expect(within(card).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Reads correctly", "Clean text"]);
    expect(within(card).getByText("Pick a single-column theme in the Themes panel.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Turn the photo off in your profile" })).toHaveAttribute("href", "/profile?section=basics");
    // The preview's own page count is still the one line that ends that way.
    expect(previewLabel()).toBe("Modern");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("waits while a theme is being customised, and says so", async () => {
    const user = userEvent.setup();
    render(<ResumeWorkspace {...props} />);
    await user.click(button());
    await screen.findByRole("region", { name: "ATS check" });

    await user.click(screen.getByRole("tab", { name: "Customize" }));
    expect(button()).toHaveAttribute("aria-disabled", "true");
    // The preview shows the draft, which the report isn't about.
    expect(screen.queryByRole("region", { name: "ATS check" })).not.toBeInTheDocument();
    await user.click(button());
    expect(toast).toHaveBeenCalledWith("Save or cancel the theme you're customising first: the check prints your saved base theme.");
    expect(checkBaseResumeAts).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(button()).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("region", { name: "ATS check" })).toBeInTheDocument();
    expect(screen.queryByText(/changed since this check/)).not.toBeInTheDocument();
  });

  it("marks the report stale once another theme is in use, and says when the check fails", async () => {
    const user = userEvent.setup();
    render(<ResumeWorkspace {...props} />);
    await user.click(button());
    await screen.findByRole("region", { name: "ATS check" });
    await user.click(screen.getByRole("button", { name: "Classic theme" }));
    expect(screen.getByText("The resume changed since this check — run it again.")).toBeInTheDocument();

    vi.mocked(checkBaseResumeAts).mockResolvedValueOnce({ ok: false, error: "The PDF couldn't be made just now." });
    await user.click(button());
    expect(toast).toHaveBeenCalledWith("The PDF couldn't be made just now.");
  });
});

