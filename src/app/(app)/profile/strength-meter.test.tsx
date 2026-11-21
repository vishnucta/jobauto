import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BASICS_FIELDS, type ProfileData } from "@/lib/profile";

import { StrengthMeter } from "./strength-meter";

const basics: ProfileData["basics"] = {
  ...(Object.fromEntries(BASICS_FIELDS.map((field) => [field, ""])) as Record<(typeof BASICS_FIELDS)[number], string>),
  showAge: false,
};

describe("StrengthMeter", () => {
  it("is a labelled progress bar with the score and the hint", () => {
    render(
      <StrengthMeter
        profile={{ basics: { ...basics, name: "Jane" }, skills: [], languages: [], experience: [{} as never], projects: [], education: [], certifications: [], publications: [], references: [], customSections: [], facts: [], photo: null }}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Profile strength" });
    expect(bar).toHaveAttribute("aria-valuenow", "37"); // 1/6 × 40 = 6.7 → plus 30
    // The hint names the next missing thing (E33-1).
    expect(bar).toHaveAccessibleDescription("A good start. Add your email address in Basics.");
    expect(screen.getByText("37%")).toBeInTheDocument();
  });

  it("gives experience its points for a paid role only, not for volunteering alone (#294)", () => {
    const volunteering = { volunteering: true } as never;
    render(
      <StrengthMeter
        profile={{ basics: { ...basics, name: "Jane" }, skills: [], languages: [], experience: [volunteering], projects: [], education: [], certifications: [], publications: [], references: [], customSections: [], facts: [], photo: null }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Profile strength" })).toHaveAttribute("aria-valuenow", "7");
  });
});

describe("StrengthMeter's hint (E33-1)", () => {
  it("names a role with no lines once the basics are there", () => {
    const full = { ...basics, name: "Jane", email: "jane@example.com", city: "Rotterdam", country: "Netherlands", headline: "Designer", summary: "Designs." };
    render(
      <StrengthMeter
        profile={{ basics: full, skills: [], languages: [], experience: [{ bullets: "Led it" } as never, { bullets: "" } as never], projects: [], education: [], certifications: [], publications: [], references: [], customSections: [], facts: [], photo: null }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Profile strength" })).toHaveAccessibleDescription("Good progress. One role has no lines yet.");
  });
});

describe("StrengthMeter without levels (jobauto fork)", () => {
  const full = { ...basics, name: "Erika Mustermann", email: "erika@example.com", city: "Hamburg", country: "Germany", headline: "Financial analyst", summary: "Reports." };
  const complete: ProfileData = {
    basics: full,
    skills: [{} as never],
    languages: [],
    experience: [{ bullets: "Closed the books" } as never],
    projects: [],
    education: [{} as never],
    certifications: [],
    publications: [],
    references: [],
    customSections: [],
    facts: [],
    photo: null,
  };

  it("never says All set while the levels are missing: they're the next thing to add", () => {
    render(<StrengthMeter profile={complete} levels={null} />);
    const bar = screen.getByRole("progressbar", { name: "Profile strength" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAccessibleDescription("Nearly there. Choose the levels this profile is for, under Jobs it's for: nothing is scored until you do.");
    expect(screen.queryByText(/All set/)).not.toBeInTheDocument();
  });

  it("names the levels before anything else missing", () => {
    render(<StrengthMeter profile={{ ...complete, basics: { ...full, headline: "" } }} levels={null} />);
    expect(screen.getByRole("progressbar", { name: "Profile strength" })).toHaveAccessibleDescription(/Choose the levels this profile is for/);
  });

  it("says All set once they're chosen", () => {
    render(<StrengthMeter profile={complete} levels={{ from: "mid", to: "senior" }} />);
    expect(screen.getByRole("progressbar", { name: "Profile strength" })).toHaveAccessibleDescription("All set. The optional sections are there if they help.");
  });
});
