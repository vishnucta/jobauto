import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";

import { AboutSection } from "./about-section";
import { checkUpdates, updateSettings } from "./actions";

vi.mock("./actions", () => ({ checkUpdates: vi.fn(), updateSettings: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));

const updates = { daily: true, available: null };
const release = { version: "0.2.0", url: "https://github.com/AienTech/dossier/releases/tag/v0.2.0" };
const facts = [
  { label: "Version", value: "0.1.0" },
  { label: "Database", value: "PostgreSQL · 9.0 MB" },
];

beforeEach(() => vi.clearAllMocks());

describe("About (E10-9)", () => {
  it("lists the install's facts", () => {
    render(<AboutSection facts={facts} updates={updates} />);
    expect(screen.getByRole("heading", { name: "About this install" })).toBeInTheDocument();
    expect(screen.getByText("Free and open source. No accounts, no subscriptions.")).toBeInTheDocument();
    expect(screen.getAllByRole("definition").map((value) => value.textContent)).toEqual(["0.1.0", "PostgreSQL · 9.0 MB"]);
    expect(screen.getByText("PostgreSQL · 9.0 MB")).toHaveClass("font-mono");
    expect(checkUpdates).not.toHaveBeenCalled();
  });

  it("says this is the jobauto fork, and links its source and the project it comes from", () => {
    render(<AboutSection facts={facts} updates={updates} />);
    expect(screen.getByText(/This is jobauto, a personal fork of Dossier/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "github.com/vishnucta/jobauto (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/vishnucta/jobauto");
    expect(screen.getByRole("link", { name: "github.com/AienTech/dossier (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/AienTech/dossier");
  });

  it("has no usage ping: nothing about this install is sent anywhere", () => {
    render(<AboutSection facts={facts} updates={updates} />);
    expect(screen.queryByRole("switch", { name: /usage ping/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
  });

  it("checks for updates daily unless switched off", async () => {
    const user = userEvent.setup();
    render(<AboutSection facts={facts} updates={updates} />);
    const toggle = screen.getByRole("switch", { name: "Check for updates daily" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription(/asks GitHub for the latest release, and the sidebar says when a newer one is out/);
    await user.click(toggle);
    expect(updateSettings).toHaveBeenCalledWith({ updateCheck: false });
    expect(toggle).toHaveAccessibleDescription("Off. Dossier only checks when you press Check for updates.");
  });

  it("switches back when the change isn't saved", async () => {
    const user = userEvent.setup();
    vi.mocked(updateSettings).mockResolvedValueOnce({ ok: false, error: "You seem to be offline." });
    render(<AboutSection facts={facts} updates={updates} />);
    await user.click(screen.getByRole("switch", { name: "Check for updates daily" }));
    expect(toast).toHaveBeenCalledWith("You seem to be offline.");
    expect(screen.getByRole("switch", { name: "Check for updates daily" })).toHaveAttribute("aria-checked", "true");
  });

  it("shows a newer version a check already found, with how to update", () => {
    render(<AboutSection facts={facts} updates={{ daily: true, available: release }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Version 0.2.0 is available.");
    expect(screen.getByRole("link", { name: "How to update (opens in a new tab)" })).toHaveAttribute("href", "https://github.com/AienTech/dossier/wiki/Upgrading");
    expect(checkUpdates).not.toHaveBeenCalled();
  });

  it("checks for updates when asked", async () => {
    const user = userEvent.setup();
    vi.mocked(checkUpdates).mockResolvedValueOnce({ ok: true, data: { status: "latest" } });
    render(<AboutSection facts={facts} updates={updates} />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(screen.getByRole("status")).toHaveTextContent("You're on the latest version.");
  });

  it("links a newer version", async () => {
    const user = userEvent.setup();
    vi.mocked(checkUpdates).mockResolvedValueOnce({ ok: true, data: { status: "newer", ...release } });
    render(<AboutSection facts={facts} updates={updates} />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(screen.getByRole("status")).toHaveTextContent("Version 0.2.0 is available.");
    expect(screen.getByRole("link", { name: "See what's new (opens in a new tab)" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("says when it couldn't check", async () => {
    const user = userEvent.setup();
    vi.mocked(checkUpdates).mockResolvedValueOnce({ ok: true, data: { status: "unknown" } });
    render(<AboutSection facts={facts} updates={updates} />);
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't check for updates right now.");
  });
});
