import { env } from "@/lib/env";

/**
 * The address the browser reaches Dossier at: DOSSIER_PUBLIC_URL, else the
 * forwarded host and protocol behind a reverse proxy, else the request's own.
 * Google's redirect and the Claude connector's addresses (#221) use it.
 */
export function publicOrigin(request: Request): string {
  return env.DOSSIER_PUBLIC_URL ?? calledAt(request).origin;
}

/** The address a request was sent to: the forwarded host and protocol (a proxy's, or Next.js's own copy of Host), else the request's own. */
function calledAt(request: Request): { host: string; origin: string } {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  return host ? { host, origin: `${protocol}://${host}` } : { host: url.host, origin: url.origin };
}

/**
 * A home-network IPv4 address, with an optional port. Never a name, so a
 * domain rebound to the server can't pass for one, and never loopback, which
 * is what a proxy on the same machine calls.
 */
const LAN_HOST = /^(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?$/;

/** This machine, with a port: what a tunnel or port forward on the app's own computer is called at. */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d{1,5})$/;

/**
 * A loopback address on a port other than the one Dossier listens on: an SSH
 * tunnel or port forward the user set up. A proxy beside Dossier, such as
 * `tailscale serve`, calls Dossier's own port, so it doesn't count.
 */
function forwardedToHere(host: string): boolean {
  const port = LOOPBACK_HOST.exec(host)?.[1];
  return port !== undefined && Number(port) !== Number(process.env.PORT ?? 3000);
}

/**
 * The address the MCP connector's sign-in is given at. With DOSSIER_PUBLIC_URL
 * set, an app that called a home-network address, or a tunnel to Dossier, gets
 * that address back, since it may not be able to reach the public one. MCP
 * apps sign in over plain HTTP only at localhost, so a tunnel is how a computer
 * without the public address connects. Everyone else gets publicOrigin.
 */
export function connectorOrigin(request: Request): string {
  const called = calledAt(request);
  return env.DOSSIER_PUBLIC_URL && (LAN_HOST.test(called.host) || forwardedToHere(called.host)) ? called.origin : publicOrigin(request);
}
