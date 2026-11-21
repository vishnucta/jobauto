import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelView } from "@/lib/notifications/channels";
import { EVENT_NAMES, EVENTS, onlyEvent } from "@/lib/notifications/events";

import { updateSettings } from "./actions";
import { addSupporterChannel, sendDigestNow } from "./notifications-actions";
import { NotificationsSection } from "./notifications-section";

vi.mock("./actions", () => ({ updateSettings: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("./notifications-actions", () => ({
  saveNotificationChannel: vi.fn(),
  deleteNotificationChannel: vi.fn(),
  setNotificationEvent: vi.fn(),
  setNotificationOnlyNew: vi.fn(),
  resumeNotificationChannel: vi.fn(),
  testNotificationChannel: vi.fn(),
  copyWebhookSecret: vi.fn(),
  regenerateNotificationSecret: vi.fn(),
  addSupporterChannel: vi.fn(),
  sendDigestNow: vi.fn(async () => ({ ok: true, data: [] })),
}));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: unknown) => result }));

const own: ChannelView = {
  id: "c1",
  type: "NTFY",
  name: "Phone",
  config: { server: "https://ntfy.sh/", topic: "jobauto-own" },
  summary: "https://ntfy.sh/jobauto-own",
  events: Object.fromEntries(EVENT_NAMES.map((name) => [name, EVENTS[name].on])) as ChannelView["events"],
  onlyNew: true,
  hasSecret: false,
  pausedAt: null,
  failuresInARow: 0,
  warning: null,
};
const supporter: ChannelView = { ...own, id: "c2", name: "Supporter", config: { server: "https://ntfy.sh/", topic: "jobauto-theirs" }, summary: "https://ntfy.sh/jobauto-theirs", events: onlyEvent("supporter.digest") };

beforeEach(() => vi.clearAllMocks());

describe("Settings → Notifications → Weekly digest for a supporter (jobauto fork)", () => {
  it("is an event, off for her own channels, and the supporter's topic becomes a channel with only it on", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection initial={{ channels: [own], log: [], supporter: { day: 1, hour: 8 } }} />);
    const grid = screen.getByRole("table");
    expect(within(grid).getByRole("switch", { name: "Weekly digest for a supporter, to Phone" })).not.toBeChecked();
    const digest = screen.getByRole("region", { name: "Weekly digest for a supporter" });
    expect(within(digest).getByText("Off. Nothing is sent until a channel gets it.")).toBeInTheDocument();
    expect(within(digest).queryByRole("button", { name: "Send this week's now" })).not.toBeInTheDocument();

    await user.type(within(digest).getByLabelText("Their topic address"), "not an address");
    expect(within(digest).getByText("An address such as https://ntfy.sh/their-topic")).toBeInTheDocument();
    await user.clear(within(digest).getByLabelText("Their topic address"));
    await user.click(within(digest).getByRole("button", { name: "Make one up" }));
    vi.mocked(addSupporterChannel).mockResolvedValueOnce({ ok: true, data: supporter });
    await user.click(within(digest).getByRole("button", { name: "Add their channel" }));
    expect(addSupporterChannel).toHaveBeenCalledWith({ address: expect.stringMatching(/^https:\/\/ntfy\.sh\/jobauto-/) });
    // Their channel joins the grid, with only the digest on.
    expect(await within(grid).findByRole("switch", { name: "Weekly digest for a supporter, to Supporter" })).toBeChecked();
    expect(within(grid).getByRole("switch", { name: "Strong new matches, to Supporter" })).not.toBeChecked();
    expect(digest).toHaveTextContent("On: it goes to Supporter (https://ntfy.sh/jobauto-theirs).");
  });

  it("sends this week's now to its channel, and saves the day and hour it goes", async () => {
    const user = userEvent.setup();
    render(<NotificationsSection initial={{ channels: [own, supporter], log: [], supporter: { day: 1, hour: 8 } }} />);
    const digest = screen.getByRole("region", { name: "Weekly digest for a supporter" });
    await user.click(within(digest).getByRole("button", { name: "Send this week's now" }));
    expect(sendDigestNow).toHaveBeenCalledWith({});
    await user.selectOptions(within(digest).getByLabelText("Every"), "Sunday");
    expect(updateSettings).toHaveBeenLastCalledWith({ supporterDay: 7 });
    await user.selectOptions(within(digest).getByLabelText("From"), "18:00");
    expect(updateSettings).toHaveBeenLastCalledWith({ supporterHour: 18 });
  });

  it("is left out where the section isn't given its day and hour", () => {
    render(<NotificationsSection initial={{ channels: [own], log: [] }} />);
    expect(screen.queryByRole("region", { name: "Weekly digest for a supporter" })).not.toBeInTheDocument();
  });
});
