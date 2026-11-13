import { z } from "zod";

// Where the apply assistant's browser window opens (bewerbung fork): on the
// computer the app runs on, or, when it runs on a server such as a NAS, in a
// Chrome on the laptop the user applies from. The server drives that Chrome
// through its remote debugging port, reached over Tailscale. Shared with
// the browser, so nothing here reads the database.

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Chrome only answers its debugging port when it's addressed by an IP address or as localhost. */
const chromeAnswers = (hostname: string) => hostname === "localhost" || IPV4.test(hostname) || hostname.startsWith("[");

/**
 * The address of the laptop's Chrome, e.g. "100.101.102.103:9222" or
 * "http://100.101.102.103:9222", saved as "http://100.101.102.103:9222".
 */
export const browserAddressSchema = z
  .string()
  .trim()
  .min(1, "Enter the address of your laptop's Chrome, e.g. http://100.101.102.103:9222.")
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
    } catch {
      context.addIssue({ code: "custom", message: "That isn't an address. Enter it like http://100.101.102.103:9222." });
      return z.NEVER;
    }
    if (url.protocol !== "http:") {
      context.addIssue({ code: "custom", message: "The address starts with http://, e.g. http://100.101.102.103:9222." });
      return z.NEVER;
    }
    if (!chromeAnswers(url.hostname)) {
      context.addIssue({ code: "custom", message: "Use the laptop's Tailscale IP address (100.x.y.z), not its name: Chrome doesn't answer names." });
      return z.NEVER;
    }
    if (!url.port) {
      context.addIssue({ code: "custom", message: "Add the port Chrome listens on, e.g. :9222 at the end." });
      return z.NEVER;
    }
    return `http://${url.host}`;
  });
