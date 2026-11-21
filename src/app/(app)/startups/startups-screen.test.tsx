import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { startupFilterSchema } from "@/lib/startups/types";

import { refreshStartupsNow, setStartupSource } from "./actions";
import { StartupsScreen } from "./startups-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }), usePathname: () => "/startups" }));
vi.mock("next/link", () => ({ default: ({ href, ...props }: ComponentProps<"a">) => <a href={href} {...props} /> }));
vi.mock("@/hooks/use-job", () => ({ useJob: () => null }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean }) => result }));
vi.mock("./actions", () => ({
  refreshStartupsNow: vi.fn(async () => ({ ok: true, data: { jobId: "refresh-1" } })),
  setStartupSource: vi.fn(async ({ source, on }: { source: string; on: boolean }) => ({ ok: true, data: { YC: false, HN: false, LICENCE: true, [source]: on } })),
  lookUpStartupAddresses: vi.fn(),
  removeStartupForGood: vi.fn(),
  saveStartupNotes: vi.fn(),
  setStartupStatus: vi.fn(),
  startScoringStartup: vi.fn(),
}));

const props = (change: Partial<ComponentProps<typeof StartupsScreen>> = {}): ComponentProps<typeof StartupsScreen> => ({
  filter: startupFilterSchema.parse({}),
  list: { startups: [], total: 0, counts: { HIRING: 0, NEW: 0, SAVED: 0, APPLIED: 0, DISMISSED: 0 } },
  lastRefresh: null,
  refreshJobId: null,
  city: "Hamburg",
  country: "Germany",
  headline: "Financial Analyst",
  aiReady: true,
  today: "2026-11-21T10:00:00.000Z",
  ...change,
});

beforeEach(() => vi.clearAllMocks());

describe("Startups' sources (jobauto fork)", () => {
  it("asks only ESMA's registers until the others are switched on, and switches each one on its own", async () => {
    render(<StartupsScreen {...props({ sources: { YC: false, HN: false, LICENCE: true } })} />);
    const bar = screen.getByRole("region", { name: "Sources" });
    expect(within(bar).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["ESMA new licences", "Hamburg or remote"]);

    await userEvent.click(within(bar).getByRole("button", { name: "Sources" }));
    const editor = screen.getByRole("group", { name: "Sources to ask" });
    expect(within(editor).getAllByRole("switch").map((toggle) => [toggle.getAttribute("aria-checked")])).toEqual([["false"], ["false"], ["true"]]);
    await userEvent.click(within(editor).getByRole("switch", { name: /^Hacker News/ }));
    expect(setStartupSource).toHaveBeenCalledWith({ source: "HN", on: true });
    expect(await within(bar).findByText("HN “Who is hiring?”")).toBeInTheDocument();
  });

  it("can't refresh with every source off", async () => {
    render(<StartupsScreen {...props({ sources: { YC: false, HN: false, LICENCE: false } })} />);
    expect(screen.getByText("No source on")).toBeInTheDocument();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(refresh);
    expect(refreshStartupsNow).not.toHaveBeenCalled();
  });
});
