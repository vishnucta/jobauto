// Whether the apply assistant's browser window can open (round 2 of the
// audit, jobauto fork). Windows and macOS always have a screen; Linux has one
// only with an X or Wayland display, which a NAS or a container hasn't. A
// laptop's Chrome saved for it (browser.ts) is a window all the same.

type Environment = { platform: NodeJS.Platform; env: Readonly<Record<string, string | undefined>> };

/** Whether the computer the app runs on can show a window. */
export function hasDisplay({ platform, env }: Environment = { platform: process.platform, env: process.env }): boolean {
  if (platform !== "linux" && platform !== "freebsd" && platform !== "openbsd") return true;
  return Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

/** Why no browser window can open, in plain words, or null when one can. */
export function noWindowReason(browserAddress: string | null, environment?: Environment): string | null {
  if (browserAddress) return null;
  if (hasDisplay(environment)) return null;
  return (
    "Dossier runs on a computer without a screen, such as a NAS, so it can't open the employer's form in a browser window there, and nothing was opened. " +
    "Connect the Chrome on the user's laptop in Dossier first (Browser window on an application's Apply tab), or apply by hand with the PDFs."
  );
}
