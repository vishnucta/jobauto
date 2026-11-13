import { chromium, type BrowserContext } from "playwright-core";

import { type BrowserChannel, channelOrder, launchWithFallback } from "@/lib/browser/launch";

// The apply assistant's browser (Phase A): a visible Chrome window with a
// profile of its own, kept between runs so the user stays signed in to
// Workday, SuccessFactors or StepStone, and her cookie choices stick. One
// window for the whole app; it opens on the first run and closes when she
// closes it. Not the PDF printer's headless browser: that one may only
// talk to the app itself.
//
// When the app runs on a server without a screen (bewerbung fork), the
// window is a Chrome on her laptop instead, started with its debugging port
// open, which the server connects to at the address saved on the Apply tab.
// That Chrome is hers: the app only connects and disconnects, never closes it.

type Opened = { context: BrowserContext; close: () => Promise<void> };
type State = { opened: Promise<Opened> | null; address: string | null };

// On globalThis so the dev server's hot reloads don't open a second window.
const globalForApply = globalThis as unknown as { applyBrowser?: State };
const state: State = (globalForApply.applyBrowser ??= { opened: null, address: null });

/** The installed browsers first: they look like her own, and keep her logins. */
const DEFAULT_ORDER: readonly BrowserChannel[] = ["chrome", "msedge", "chromium"];

/** How long the laptop's Chrome gets to answer. */
const CONNECT_TIMEOUT_MS = 15_000;

/** A Chrome window on the computer the app runs on. */
function launch(userDataDir: string, channel: BrowserChannel | undefined, forget: () => void): Promise<Opened> {
  return launchWithFallback(
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
    context.on("close", forget);
    return { context, close: () => context.close() };
  });
}

/** The Chrome on her laptop, at its debugging address. Its own window and profile are used, as they are. */
async function connect(address: string, forget: () => void): Promise<Opened> {
  // Not on the same computer: Playwright sends the PDFs' contents across, not their paths.
  const browser = await chromium.connectOverCDP(address, { timeout: CONNECT_TIMEOUT_MS });
  browser.on("disconnected", forget);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  // Closing a browser that was connected to only disconnects: her Chrome and its tabs stay open.
  return { context, close: () => browser.close() };
}

/**
 * The shared browser context, started (or connected to) if it isn't open.
 * `address` is the laptop's Chrome, or null for a window on this computer;
 * when it changes, the old window is let go first.
 */
export async function applyContext({ userDataDir, channel, address = null }: { userDataDir: string; channel?: BrowserChannel; address?: string | null }): Promise<BrowserContext> {
  if (state.opened && state.address !== address) await closeApplyBrowser();
  if (!state.opened) {
    const forget = () => {
      if (state.opened === opening) state.opened = null;
    };
    const opening: Promise<Opened> = address ? connect(address, forget) : launch(userDataDir, channel, forget);
    opening.catch(forget);
    state.opened = opening;
    state.address = address;
  }
  return (await state.opened).context;
}

/** Whether the window is open. */
export function applyBrowserOpen(): boolean {
  return state.opened !== null;
}

/** Closes the window on this computer, or lets go of the laptop's Chrome, if either is open. */
export async function closeApplyBrowser(): Promise<void> {
  const closing = state.opened;
  state.opened = null;
  if (!closing) return;
  await closing.then((opened) => opened.close()).catch(() => {});
}
