import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { frontPage } from "./tabs";

type Tab = { name: string; state: "visible" | "hidden" | "throws"; closed?: boolean };

/** The tabs of a window, in the order they were opened; `of` is the one the run is watching. */
function tabsOf(tabs: Tab[], of: string) {
  const pages: Page[] = [];
  const context = { pages: () => pages };
  for (const tab of tabs) {
    pages.push({
      isClosed: () => Boolean(tab.closed),
      context: () => context,
      evaluate: async () => {
        if (tab.state === "throws") throw new Error("Execution context was destroyed");
        return tab.state;
      },
      __name: tab.name,
    } as unknown as Page);
  }
  const byName = (name: string) => pages[tabs.findIndex((tab) => tab.name === name)];
  return { fallback: byName(of), byName };
}

describe("frontPage: the tab the user is looking at", () => {
  it("is the run's own tab when it is the only one", async () => {
    const { fallback } = tabsOf([{ name: "run", state: "visible" }], "run");
    expect(await frontPage(fallback)).toBe(fallback);
  });

  it("is the tab she opened to get past a login or a check, when that is the one in front", async () => {
    const { fallback, byName } = tabsOf(
      [
        { name: "run", state: "hidden" },
        { name: "hers", state: "visible" },
      ],
      "run",
    );
    expect(await frontPage(fallback)).toBe(byName("hers"));
  });

  it("is the run's tab again when she went back to it", async () => {
    const { fallback, byName } = tabsOf(
      [
        { name: "run", state: "visible" },
        { name: "hers", state: "hidden" },
      ],
      "run",
    );
    expect(await frontPage(fallback)).toBe(byName("run"));
  });

  it("is the newest of several visible tabs, as with two windows", async () => {
    const { fallback, byName } = tabsOf(
      [
        { name: "run", state: "visible" },
        { name: "second window", state: "visible" },
      ],
      "run",
    );
    expect(await frontPage(fallback)).toBe(byName("second window"));
  });

  it("is the newest tab when none says it is visible, as with the window covered by another", async () => {
    const { fallback, byName } = tabsOf(
      [
        { name: "run", state: "hidden" },
        { name: "hers", state: "hidden" },
      ],
      "run",
    );
    expect(await frontPage(fallback)).toBe(byName("hers"));
  });

  it("leaves out tabs that are closed or can't be read, such as a browser page", async () => {
    const { fallback, byName } = tabsOf(
      [
        { name: "run", state: "visible" },
        { name: "closed", state: "visible", closed: true },
        { name: "chrome page", state: "throws" },
      ],
      "run",
    );
    expect(await frontPage(fallback)).toBe(byName("run"));
  });

  it("is the run's tab when nothing else is open", async () => {
    const { fallback } = tabsOf([{ name: "run", state: "throws" }], "run");
    expect(await frontPage(fallback)).toBe(fallback);
  });
});
