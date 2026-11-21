import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveSupporterAddress, sendDigestNow, updateSettings } from "./actions";
import { SupporterDigest } from "./supporter-digest";

vi.mock("./actions", () => ({
  saveSupporterAddress: vi.fn(async ({ address }: { address: string | null }) => ({ ok: true, data: { address } })),
  sendDigestNow: vi.fn(async () => ({ ok: true, data: null })),
  updateSettings: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

beforeEach(() => vi.clearAllMocks());

describe("Settings → Weekly digest for a supporter", () => {
  it("saves the supporter's topic, sends this week's now, and turns it off", async () => {
    const user = userEvent.setup();
    render(<SupporterDigest initial={{ address: null, day: 1, hour: 8 }} />);
    expect(screen.getByText("Off. Nothing is sent until a topic is saved.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Their topic address"), "not an address");
    expect(screen.getByText("An address such as https://ntfy.sh/their-topic")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Their topic address"));
    await user.click(screen.getByRole("button", { name: "Make one up" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveSupporterAddress).toHaveBeenCalledWith({ address: expect.stringMatching(/^https:\/\/ntfy\.sh\/jobauto-/) });
    await user.click(await screen.findByRole("button", { name: "Send this week's now" }));
    expect(sendDigestNow).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    expect(saveSupporterAddress).toHaveBeenLastCalledWith({ address: null });
    expect(await screen.findByText("Off. Nothing is sent until a topic is saved.")).toBeInTheDocument();
  });

  it("saves the day and hour it goes", async () => {
    const user = userEvent.setup();
    render(<SupporterDigest initial={{ address: "https://ntfy.sh/jobauto-abc", day: 1, hour: 8 }} />);
    expect(screen.getByText("On: it goes to https://ntfy.sh/jobauto-abc.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Every"), "Sunday");
    expect(updateSettings).toHaveBeenLastCalledWith({ supporterDay: 7 });
    await user.selectOptions(screen.getByLabelText("From"), "18:00");
    expect(updateSettings).toHaveBeenLastCalledWith({ supporterHour: 18 });
  });
});
