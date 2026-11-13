import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";

import { removeAttachment, saveAttachment } from "./actions";
import { AnlagenCard } from "./anlagen-card";

vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));
vi.mock("./actions", () => ({
  saveAttachment: vi.fn(async ({ id, ...change }: { id: string; name?: string; enabled?: boolean }) => ({ ok: true, data: { id, name: "Arbeitszeugnis", fileName: "z.pdf", size: 1000, enabled: true, ...change } })),
  removeAttachment: vi.fn(async () => ({ ok: true, data: null })),
}));

const zeugnis = { id: "a1", name: "Arbeitszeugnis AvaTrade", fileName: "Arbeitszeugnis_AvaTrade.pdf", size: 1_300_000, enabled: true };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("Anlagen", () => {
  it("lists each with its file and size, and how many are sent", () => {
    render(<AnlagenCard initial={[zeugnis, { ...zeugnis, id: "a2", name: "Goethe A2", enabled: false }]} />);
    expect(screen.getByText("1 of 2 sent with applications.")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Named as")[0]).toHaveValue("Arbeitszeugnis AvaTrade");
    expect(screen.getAllByText("Arbeitszeugnis_AvaTrade.pdf · 1.2 MB")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /Open/ })[0]).toHaveAttribute("href", "/api/attachments/a1");
  });

  it("uploads PDFs one by one, and says which one didn't go in and why", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("bad.pdf") ? new Response(JSON.stringify({ error: "Only PDFs can be added." }), { status: 400 }) : new Response(JSON.stringify({ ...zeugnis, id: "new", name: "Zeugnis" })),
    );
    vi.stubGlobal("fetch", fetch);
    render(<AnlagenCard initial={[]} />);
    const files = [new File(["%PDF-"], "Zeugnis.pdf", { type: "application/pdf" }), new File(["x"], "bad.pdf", { type: "application/pdf" })];
    await userEvent.upload(screen.getByLabelText("Add PDFs"), files);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0][0]).toBe("/api/attachments?name=Zeugnis.pdf");
    expect(await screen.findByText("1 of 1 sent with applications.")).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith("bad.pdf: Only PDFs can be added.");
  });

  it("renames one, stops sending one, and removes one", async () => {
    render(<AnlagenCard initial={[zeugnis]} />);
    const field = screen.getByLabelText("Named as");
    await userEvent.clear(field);
    await userEvent.type(field, "Arbeitszeugnis EY");
    await userEvent.tab();
    expect(saveAttachment).toHaveBeenCalledWith({ id: "a1", name: "Arbeitszeugnis EY" });
    await userEvent.click(screen.getByRole("switch", { name: "Send it" }));
    expect(saveAttachment).toHaveBeenLastCalledWith({ id: "a1", enabled: false });
    await userEvent.click(within(screen.getByRole("list", { name: "Anlagen" })).getByRole("button", { name: /Remove/ }));
    expect(removeAttachment).toHaveBeenCalledWith({ id: "a1" });
    expect(screen.getByText("None yet.")).toBeInTheDocument();
  });
});
