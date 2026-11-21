import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomSection, ProfileData } from "@/lib/profile";

import { saveCustomSection } from "./actions";
import { CustomSectionEditor } from "./custom-section";

vi.mock("./actions", () => ({
  createCustomItem: vi.fn(),
  deleteCustomSection: vi.fn(),
  removeCustomItem: vi.fn(),
  reorderCustomItems: vi.fn(),
  restoreCustomItem: vi.fn(),
  restoreCustomSection: vi.fn(),
  saveCustomItem: vi.fn(async () => ({ ok: true, data: null })),
  saveCustomSection: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: <T,>(result: T) => result }));

const awards: CustomSection = { id: "c1", title: "Awards", format: "LINES", countsAs: "EXTRA_ACTIVITIES", items: [] };

function Harness() {
  const [profile, setProfile] = useState({ customSections: [awards] } as ProfileData);
  const section = profile.customSections[0]!;
  return <CustomSectionEditor section={section} update={(change) => setProfile(change)} onDeleted={() => {}} onRestored={() => {}} />;
}

beforeEach(() => vi.clearAllMocks());

describe("CustomSectionEditor", () => {
  it("saves a format switch once, and nothing while it only renders", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness />);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saveCustomSection).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("radio", { name: "Inline" }));
    await waitFor(() => expect(saveCustomSection).toHaveBeenCalledWith({ id: "c1", title: "Awards", format: "INLINE", countsAs: "EXTRA_ACTIVITIES" }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saveCustomSection).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("Maximum update depth"), expect.anything());
    errors.mockRestore();
  });
});
