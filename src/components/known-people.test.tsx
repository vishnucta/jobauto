import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { askForReferral } from "@/app/(app)/recruiters/actions";

import { KnownPeople } from "./known-people";
import { toast } from "./toast";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("@/app/(app)/recruiters/actions", () => ({ askForReferral: vi.fn(async () => ({ ok: true, data: { recruiterId: "r1", added: true } })) }));

const sam = { id: "c1", name: "Sam Beispiel", position: "Head of Regulatory Reporting", company: "Berenberg", url: "https://www.linkedin.com/in/sam" };

beforeEach(() => vi.clearAllMocks());

describe("KnownPeople (jobauto fork)", () => {
  it("says whom she knows there, and asks for a referral in one click", async () => {
    render(<KnownPeople people={[sam, { ...sam, id: "c2", name: "Kim Muster", position: "" }]} />);
    const note = screen.getByRole("note", { name: "People you know here" });
    expect(note).toHaveTextContent("You know someone here: Sam Beispiel (Head of Regulatory Reporting) and 1 more");
    await userEvent.click(screen.getByRole("button", { name: "See who" }));
    expect(screen.getByRole("link", { name: "Sam Beispiel on LinkedIn (opens in a new tab)" })).toHaveAttribute("href", "https://www.linkedin.com/in/sam");
    await userEvent.click(screen.getByRole("button", { name: "Ask for a referral from Sam Beispiel" }));
    expect(askForReferral).toHaveBeenCalledWith({ connectionId: "c1" });
    expect(toast).toHaveBeenCalledWith("Sam Beispiel is on Recruiters now, with the referral message ready.", expect.anything());
  });

  it("shows nothing when she knows nobody there", () => {
    const { container } = render(<KnownPeople people={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
