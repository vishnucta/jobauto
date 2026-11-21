import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { ScoringOffNotice as Notice } from "@/lib/scoring-off";

import { guessProfileLevels } from "./profile/profiles-actions";
import { ScoringOffNotice } from "./scoring-off-notice";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: (props: React.ComponentProps<"a">) => <a {...props} /> }));
vi.mock("./profile/profiles-actions", () => ({ guessProfileLevels: vi.fn() }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

beforeEach(() => vi.clearAllMocks());

const off: Notice = {
  title: "Scoring is off: choose the levels your profile is for.",
  body: "Until then no posting gets a score: Best fit can't sort, How you fit doesn't run, and the job agent and strong-match alerts wait.",
  reason: "Choose the levels your profile is for. Nothing is scored until you do.",
  href: "/profile?section=target&profile=p1",
  profileId: "p1",
  canGuess: true,
};

describe("ScoringOffNotice (jobauto fork)", () => {
  it("says scoring is off and links Choose levels to Profile → Jobs it's for", () => {
    render(<ScoringOffNotice off={off} />);
    const notice = screen.getByRole("region", { name: "Scoring is off" });
    expect(notice).toHaveTextContent("Scoring is off: choose the levels your profile is for. Until then no posting gets a score");
    expect(screen.getByRole("link", { name: "Choose levels" })).toHaveAttribute("href", "/profile?section=target&profile=p1");
    // It stays: there's nothing to dismiss it with.
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  it("guesses the levels with AI, says what they are and shows the page without the notice", async () => {
    vi.mocked(guessProfileLevels).mockResolvedValue({ ok: true, data: { from: "mid", to: "senior" } });
    render(<ScoringOffNotice off={off} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Guess with AI" }));
    expect(guessProfileLevels).toHaveBeenCalledWith({ profileId: "p1" });
    expect(toast).toHaveBeenCalledWith("Levels set to Mid level to Senior. Change them in Profile → Jobs it's for.");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("leaves the page as it is when the guess fails", async () => {
    vi.mocked(guessProfileLevels).mockResolvedValue({ ok: false, error: "Add a role or two to this profile first: the guess comes from them." });
    render(<ScoringOffNotice off={off} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Guess with AI" }));
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Guess with AI" })).toBeInTheDocument();
  });

  it("offers no guess when Dossier's AI model can't make one", () => {
    render(<ScoringOffNotice off={{ ...off, canGuess: false }} />);
    expect(screen.queryByRole("button", { name: "Guess with AI" })).not.toBeInTheDocument();
  });
});
