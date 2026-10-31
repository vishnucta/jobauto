import { chromium, type BrowserContext } from "playwright-core";

import { type BrowserChannel, channelOrder, launchWithFallback } from "@/lib/browser/launch";

// The apply assistant's browser (Phase A): a visible Chrome window with a
// profile of its own, kept between runs so the user stays signed in to
// Workday, SuccessFactors or StepStone, and her cookie choices stick. One
// window for the whole app; it opens on the first run and closes when she
// closes it. Not the PDF printer's headless browser: that one may only
// talk to the app itself.

type State = { context: Promise<BrowserContext> | null };

// On globalThis so the dev server's hot reloads don't open a second window.
const globalForApply = globalThis as unknown as { applyBrowser?: State };
const state: State = (globalForApply.applyBrowser ??= { context: null });

/** The installed browsers first: they look like her own, and keep her logins. */
const DEFAULT_ORDER: readonly BrowserChannel[] = ["chrome", "msedge", "chromium"];

/** The shared browser context, started if it isn't open. */
export function applyContext({ userDataDir, channel }: { userDataDir: string; channel?: BrowserChannel }): Promise<BrowserContext> {
  if (!state.context) {
    const launching = launchWithFallback(
      (options) =>
        chromium.launchPersistentContext(userDataDir, {
          ...options,
          headless: false,
          // The window's own size, not a fixed viewport.
          viewport: null,
          locale: "de-DE",
          args: ["--start-maximized"],
        }),
      channelOrder(channel, DEFAULT_ORDER),
    ).then((context) => {
      context.on("close", () => {
        if (state.context === launching) state.context = null;
      });
      return context;
    });
    launching.catch(() => {
      if (state.context === launching) state.context = null;
    });
    state.context = launching;
  }
  return state.context;
}

/** Whether the window is open. */
export function applyBrowserOpen(): boolean {
  return state.context !== null;
}

/** Closes the window, if it's open. */
export async function closeApplyBrowser(): Promise<void> {
  const closing = state.context;
  state.context = null;
  if (!closing) return;
  await closing.then((context) => context.close()).catch(() => {});
}
