import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GERMAN_PLACES } from "@/lib/careers/field-employers";

import { addEmployer } from "./actions";
import { FieldEmployersCard } from "./field-employers-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("./actions", () => ({ addEmployer: vi.fn(async (input: { name: string; careersUrl: string }) => ({ ok: true, data: { id: "new", ...input } })) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const employers = [
  { name: "Raisin", cities: "Berlin", why: "Regulatory reporting.", careersUrl: "https://boards.greenhouse.io/raisin", followUrl: "https://boards.greenhouse.io/raisin" },
  { name: "Citi", cities: "Frankfurt", why: "Regulatory reporting for its German entities.", careersUrl: "https://jobs.citi.com" },
];

describe("Employers in your field", () => {
  it("follows one with a readable feed, in Germany, and opens or searches every one", async () => {
    const user = userEvent.setup();
    const onFollowed = vi.fn();
    render(<FieldEmployersCard employers={employers} followed={new Set()} suggestedWords="Regulatory Reporting, Analyst" network={{}} onFollowed={onFollowed} />);
    await user.click(screen.getByText("Employers in your field"));
    expect(screen.getByRole("link", { name: "Careers page of Citi (opens in a new tab)" })).toHaveAttribute("href", "https://jobs.citi.com");
    expect(screen.getByRole("link", { name: "Search Citi on Positions" })).toHaveAttribute("href", "/jobs?q=Citi+Regulatory+Reporting&country=de");
    expect(screen.queryByRole("button", { name: "Follow Citi" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Follow Raisin" }));
    expect(addEmployer).toHaveBeenCalledWith({ name: "Raisin", careersUrl: "https://boards.greenhouse.io/raisin", keywords: "Regulatory Reporting, Analyst", places: GERMAN_PLACES, notes: "Regulatory reporting." });
    expect(onFollowed).toHaveBeenCalled();
  });

  it("says when one is followed already", async () => {
    render(<FieldEmployersCard employers={employers} followed={new Set(["https://boards.greenhouse.io/raisin"])} suggestedWords="" network={{}} onFollowed={vi.fn()} />);
    await userEvent.setup().click(screen.getByText("Employers in your field"));
    expect(screen.getByText("Following")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Follow Raisin" })).not.toBeInTheDocument();
  });
});
