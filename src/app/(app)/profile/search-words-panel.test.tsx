import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import type { ProfileData } from "@/lib/profile";

import { SearchWordsPanel } from "./search-words-panel";

vi.mock("next/link", () => ({ default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} /> }));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));

type Fixture = Pick<ProfileData, "basics" | "skills" | "experience">;

const role = (patch: Partial<Fixture["experience"][number]> = {}): Fixture["experience"][number] => ({
  id: "e1",
  role: "Financial Analyst",
  company: "AvaTrade",
  location: "",
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
  basics: { name: "Prearna", headline: "Financial Analyst — Regulatory Reporting & Reconciliation", city: "Hamburg", country: "Germany" } as Fixture["basics"],
  skills: [
    { id: "s1", name: "Audit Support" },
    { id: "s2", name: "Data Analysis" },
  ],
  experience: [role()],
  ...patch,
});

const group = (name: string) => screen.getByRole("region", { name });
const words = (name: string) => within(group(name)).getAllByRole("listitem").map((item) => within(item).getAllByRole("button")[0].textContent);

beforeEach(() => vi.clearAllMocks());

describe("the Search words panel", () => {
  it("lists the words from the profile in groups, for the place, with the German ones", () => {
    render(<SearchWordsPanel profile={profile()} />);
    const panel = screen.getByRole("complementary", { name: "Search words" });
    expect(panel).toHaveTextContent("For Find jobs, Hamburg, Germany.");
    expect(words("Job titles")).toEqual(["Financial Analyst", "Senior Financial Analyst", "Regulatory Reporting Analyst", "Reconciliation Analyst", "Finanzanalyst", "Senior Finanzanalyst", "Analyst Meldewesen"]);
    expect(words("Specialties")).toEqual(["Regulatory Reporting", "Reconciliation", "Meldewesen", "Kontenabstimmung"]);
    expect(words("From your skills")).toEqual(["Audit Support", "Data Analysis", "Datenanalyse"]);
  });

  it("copies a word when it is clicked, and links to Find jobs with it filled in", async () => {
    const user = userEvent.setup();
    render(<SearchWordsPanel profile={profile()} />);
    await user.click(within(group("Specialties")).getByRole("button", { name: "Meldewesen" }));
    expect(await navigator.clipboard.readText()).toBe("Meldewesen");
    expect(toast).toHaveBeenCalledWith("Copied “Meldewesen”. Paste it into What on Find jobs.");
    expect(screen.getByRole("link", { name: "Search Find jobs for Meldewesen" })).toHaveAttribute("href", "/jobs?q=Meldewesen&where=Hamburg&country=de");
    expect(screen.getByRole("link", { name: "Search Find jobs for Financial Analyst" })).toHaveAttribute("href", "/jobs?q=Financial+Analyst&where=Hamburg&country=de");
  });

  it("shows only English or only German words, and copies what is shown, one per line", async () => {
    const user = userEvent.setup();
    render(<SearchWordsPanel profile={profile()} />);
    await user.click(screen.getByRole("button", { name: "Deutsch" }));
    expect(screen.getByRole("button", { name: "Deutsch" })).toHaveAttribute("aria-pressed", "true");
    expect(words("Job titles")).toEqual(["Finanzanalyst", "Senior Finanzanalyst", "Analyst Meldewesen"]);
    expect(words("Specialties")).toEqual(["Meldewesen", "Kontenabstimmung"]);
    await user.click(screen.getByRole("button", { name: "Copy all" }));
    expect(await navigator.clipboard.readText()).toBe("Finanzanalyst\nSenior Finanzanalyst\nAnalyst Meldewesen\nMeldewesen\nKontenabstimmung\nDatenanalyse");
    expect(toast).toHaveBeenLastCalledWith("Copied 6 words, one per line.");

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(words("Job titles")).not.toContain("Finanzanalyst");
  });

  it("says where Senior comes from, and leaves it out when unticked", async () => {
    const user = userEvent.setup();
    render(<SearchWordsPanel profile={profile()} />);
    const box = screen.getByRole("checkbox", { name: "Add “Senior” to my latest title" });
    expect(box).toBeChecked();
    expect(screen.getByText(/Your profile doesn't say “Senior”: this is a guess from the years\./)).toBeInTheDocument();
    expect(screen.getByText(/Your roles add up to about \d+ years\./)).toBeInTheDocument();
    await user.click(box);
    expect(words("Job titles")).not.toContain("Senior Financial Analyst");
    await user.click(box);
    expect(words("Job titles")).toContain("Senior Financial Analyst");
  });

  it("offers no Senior box without the years, and no language switch outside Germany, Austria and Switzerland", () => {
    render(<SearchWordsPanel profile={profile({ experience: [role({ startYear: new Date().getFullYear() })], basics: { name: "Jane", headline: "", city: "Dublin", country: "Ireland" } as Fixture["basics"] })} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Language of the postings" })).not.toBeInTheDocument();
    expect(words("Job titles")).toEqual(["Financial Analyst"]);
  });

  it("changes with the profile", () => {
    const { rerender } = render(<SearchWordsPanel profile={profile()} />);
    expect(words("From your skills")).not.toContain("Treasury");
    rerender(<SearchWordsPanel profile={profile({ skills: [{ id: "s1", name: "Treasury" }, { id: "s2", name: "Data Analysis" }] })} />);
    expect(words("From your skills")).toContain("Treasury");
    rerender(<SearchWordsPanel profile={profile({ experience: [role({ role: "Controller" })] })} />);
    expect(words("Job titles")[0]).toBe("Controller");
  });

  it("asks for a role or skills when there is nothing to go on", () => {
    render(<SearchWordsPanel profile={profile({ skills: [], experience: [], basics: { name: "", headline: "", city: "", country: "" } as Fixture["basics"] })} />);
    expect(screen.getByText("Add a role, a headline or skills, and search words appear here.")).toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
