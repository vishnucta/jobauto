// Which Chromium to start (bewerbung fork): Playwright's own build when
// it's installed, else the Chrome or Edge already on the computer. The
// PDF printer and the apply assistant both go through here, so a laptop
// without `playwright install` still works.

export const BROWSER_CHANNELS = ["chromium", "chrome", "msedge"] as const;
/** "chromium" is Playwright's bundled build; the others are installed browsers. */
export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

/** The launch options for a channel: none for the bundled build. */
export type ChannelOptions = { channel?: "chrome" | "msedge" };

/** The order to try: the preferred channel first, then the rest of `fallback` in its order. */
export function channelOrder(preferred: BrowserChannel | undefined, fallback: readonly BrowserChannel[]): BrowserChannel[] {
  return preferred ? [preferred, ...fallback.filter((channel) => channel !== preferred)] : [...fallback];
}

/**
 * Starts a browser with the first channel that works. `launch` gets the
 * channel's options and starts whatever it starts (a browser, a persistent
 * context); a channel that isn't installed throws, and the next is tried.
 */
export async function launchWithFallback<T>(launch: (options: ChannelOptions) => Promise<T>, order: readonly BrowserChannel[]): Promise<T> {
  const problems: string[] = [];
  for (const channel of order) {
    try {
      return await launch(channel === "chromium" ? {} : { channel });
    } catch (error) {
      problems.push(`${channel}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(`No browser could be started (${problems.join("; ")}). Run "yarn playwright install chromium", or install Google Chrome or Microsoft Edge.`);
}
