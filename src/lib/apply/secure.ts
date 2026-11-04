// Where the apply assistant may type her details (jobauto fork): only into a
// page that is encrypted. The assistant types her name, address, phone and
// date of birth and attaches her CV, and a page whose address starts with
// http:// carries all of it in the clear. An http:// address is tried as
// https:// first; a page that stays http:// is left alone, and she is told
// why. This computer itself (a test form on localhost) counts as safe.

/** Hosts that are this computer: nothing travels. */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Whether her details may be typed into the page at `url`: https, or this computer. */
export function isSecure(url: string): boolean {
  const parsed = parse(url);
  if (!parsed) return false;
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK.test(parsed.hostname));
}

/**
 * The https:// address for an http:// one; any other address as it was. An
 * address with a port of its own is left alone: the same port is unlikely
 * to speak https.
 */
export function upgraded(url: string): string {
  const parsed = parse(url);
  if (!parsed || parsed.protocol !== "http:" || isSecure(url) || parsed.port) return url;
  parsed.protocol = "https:";
  return parsed.toString();
}

/** What of a browser page these need, so they can be tried without a browser. */
export type Navigable = {
  url(): string;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
};

const OPEN_TIMEOUT_MS = 45_000;

/**
 * Opens `url`, as https:// first when it was given as http://, and as given
 * if that doesn't answer. False when neither opens.
 */
export async function openPreferringHttps(page: Navigable, url: string): Promise<boolean> {
  for (const candidate of new Set([upgraded(url), url])) {
    try {
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: OPEN_TIMEOUT_MS });
      return true;
    } catch {
      // The next address, if there is one.
    }
  }
  return false;
}

/**
 * Makes sure the page is encrypted before anything is typed into it: one on
 * http:// is opened again as https://. False when it stays unencrypted (it
 * doesn't answer on https, or sends the visitor back to http).
 */
export async function secured(page: Navigable): Promise<boolean> {
  if (isSecure(page.url())) return true;
  const better = upgraded(page.url());
  if (better === page.url()) return false;
  try {
    await page.goto(better, { waitUntil: "domcontentloaded", timeout: OPEN_TIMEOUT_MS });
    await page.waitForTimeout(1_500);
  } catch {
    // It doesn't answer on https: the page stays as it was.
  }
  return isSecure(page.url());
}
