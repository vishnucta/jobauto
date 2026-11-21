import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import { dismissPortalsOffNote } from "@/lib/job-search/portals-off-actions";

import { PortalsOffNote } from "./portals-off-note";

vi.mock("next/link", () => ({ default: (props: React.ComponentProps<"a">) => <a {...props} /> }));
vi.mock("@/lib/job-search/portals-off-actions", () => ({ dismissPortalsOffNote: vi.fn() }));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

const names = ["JSearch", "SerpApi", "Adzuna", "Jooble"];

describe("PortalsOffNote (jobauto fork)", () => {
  it("names the portals with a key that are off, and where to switch them on", () => {
    render(<PortalsOffNote names={names} />);
    expect(screen.getByRole("note")).toHaveTextContent("You have keys for 4 portals that are off: JSearch, SerpApi, Adzuna, Jooble. Switch them on in Settings → Job search.");
    expect(screen.getByRole("link", { name: "Settings → Job search" })).toHaveAttribute("href", "/settings?section=jobs");
  });

  it("points below in Settings → Job search, and speaks of one portal as it", () => {
    render(<PortalsOffNote names={["SerpApi"]} inSettings />);
    expect(screen.getByRole("note")).toHaveTextContent("You have a key for SerpApi, which is off. Switch it on below.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("goes for good when dismissed", async () => {
    vi.mocked(dismissPortalsOffNote).mockResolvedValue({ ok: true, data: null });
    render(<PortalsOffNote names={names} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissPortalsOffNote).toHaveBeenCalledWith({});
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("comes back, saying why, when the dismissal isn't saved", async () => {
    vi.mocked(dismissPortalsOffNote).mockResolvedValue({ ok: false, error: "Couldn't save that. Try again." });
    render(<PortalsOffNote names={names} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dismiss" }));
    expect(toast).toHaveBeenCalledWith("Couldn't save that. Try again.");
    expect(screen.getByRole("note")).toBeInTheDocument();
  });
});
