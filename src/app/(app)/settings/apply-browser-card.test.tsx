import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";

import { saveApplyBrowser, testApplyBrowser } from "./apply-browser-actions";
import { ApplyBrowserCard } from "./apply-browser-card";

// Where the apply assistant's window opens, in Settings → Standard answers (jobauto fork, audit round 2).

vi.mock("./apply-browser-actions", () => ({
  saveApplyBrowser: vi.fn(async () => ({ ok: true, data: null, toast: "Saved." })),
  testApplyBrowser: vi.fn(async () => ({ ok: true, data: { version: "Chrome/142.0.7444.60" } })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => vi.clearAllMocks());

describe("the apply assistant's browser window in Settings", () => {
  it("opens on the computer the app runs on until a laptop's Chrome is saved, and is linked to by its anchor", () => {
    render(<ApplyBrowserCard address={null} />);
    expect(screen.getByRole("region", { name: "The apply assistant's browser window" })).toHaveAttribute("id", "apply-browser");
    expect(screen.getByText(/The window opens on the computer the app runs on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/the server controls it/)).not.toBeInTheDocument();
  });

  it("saves the laptop's address, and tests it", async () => {
    const user = userEvent.setup();
    render(<ApplyBrowserCard address={null} />);
    await user.type(screen.getByLabelText("Your laptop's Chrome"), " 100.101.102.103:9222 ");
    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(testApplyBrowser).toHaveBeenCalledWith({ address: "100.101.102.103:9222" });
    expect(toast).toHaveBeenLastCalledWith("Chrome/142.0.7444.60 answered. It's ready.");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveApplyBrowser).toHaveBeenCalledWith({ address: "100.101.102.103:9222" });
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says the window opens on the laptop once one is saved, and that the server controls it", () => {
    render(<ApplyBrowserCard address="http://100.101.102.103:9222" />);
    expect(screen.getByText(/opens in the Chrome on your laptop, at http:\/\/100.101.102.103:9222/)).toBeInTheDocument();
    expect(screen.getByText(/the server controls it/)).toBeInTheDocument();
  });
});
