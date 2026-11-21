import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ProfileData } from "@/lib/profile";

import { SearchWordsPanel } from "./search-words-panel";

vi.mock("next/link", () => ({ default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} /> }));

type Fixture = Pick<ProfileData, "basics" | "skills" | "experience">;

const role = (patch: Partial<Fixture["experience"][number]> = {}): Fixture["experience"][number] => ({
  id: "e1",
  role: "Financial Analyst",
  company: "Nordbank Trading",
  location: "",
  descriptor: "",
  volunteering: false,
  bullets: "",
  skillIds: ["s1", "s2"],
  startYear: 2014,
  startMonth: 1,
  endYear: null,
  endMonth: null,
  current: true,
  ...patch,
});

const profile = (patch: Partial<Fixture> = {}): Fixture => ({
  basics: { name: "Erika", headline: "Financial Analyst — Regulatory Reporting & Reconciliation", city: "Hamburg", country: "Germany" } as Fixture["basics"],
  skills: [
    { id: "s1", name: "Audit Support", group: "" },
    { id: "s2", name: "Data Analysis", group: "" },
  ],
  experience: [role()],
  ...patch,
});

describe("the Search words panel (jobauto fork)", () => {
  it("says how many words the profile gives, and links to their one place, Positions' Edit search, instead of a second list", () => {
    render(<SearchWordsPanel profile={profile()} />);
    const panel = screen.getByRole("complementary", { name: "Search words" });
    // 7 titles, 4 specialties and 3 from the skills, as searchWords gives them.
    expect(panel).toHaveTextContent("14 short words from this profile, in English and German, to search Positions with");
    expect(screen.getByRole("link", { name: /See them in Positions/ })).toHaveAttribute("href", "/jobs?edit=1");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("changes with the profile, and leaves out German outside Germany, Austria and Switzerland", () => {
    const { rerender } = render(<SearchWordsPanel profile={profile()} />);
    rerender(<SearchWordsPanel profile={profile({ basics: { ...profile().basics, country: "Netherlands" } })} />);
    expect(screen.getByRole("complementary", { name: "Search words" })).not.toHaveTextContent("German");
  });

  it("asks for a role or skills when there is nothing to go on", () => {
    render(<SearchWordsPanel profile={profile({ skills: [], experience: [], basics: { name: "", headline: "", city: "", country: "" } as Fixture["basics"] })} />);
    expect(screen.getByText("Add a role, a headline or skills, and search words appear in Positions, under Edit search.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
