import type { Page } from "playwright-core";

// Which tab of the assistant's window "Fill this page" fills (jobauto fork):
// the one the user is looking at, not necessarily the one the run opened. She
// may have opened another tab to get past a login or a bot check, or the run
// may have followed an apply button to a new tab.

/**
 * The tab she is looking at: the window's visible tab (a background tab says
 * it is hidden), the newest if several are. When none says so, because the
 * window is covered by another, the newest tab is the likeliest: it is the
 * one she opened last. `fallback` when nothing else is open.
 */
export async function frontPage(fallback: Page): Promise<Page> {
  const open = fallback.context().pages().filter((page) => !page.isClosed());
  const visible: Page[] = [];
  for (const page of open) {
    const state = await page.evaluate(() => document.visibilityState).catch(() => null);
    if (state === "visible") visible.push(page);
  }
  return visible.at(-1) ?? open.at(-1) ?? fallback;
}
