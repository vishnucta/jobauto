// An ntfy topic's address (jobauto fork), checked on the server and in
// Settings: "https://ntfy.sh/jobauto-k3x9…", or a topic on the user's own
// ntfy server. The phone alerts' topic, moved into Notifications once
// (alert-address.ts), and the supporter digest's (supporter-digest-data.ts)
// are such addresses. Nothing here reaches the server, so the browser can
// use it too.

/** The ntfy server to publish to, and the topic: the address's last path part. */
export function ntfyTarget(address: string): { server: string; topic: string } | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const topic = parts.pop();
  if (!topic || !/^[\w-]{1,64}$/.test(topic)) return null;
  return { server: `${url.origin}/${parts.map((part) => `${part}/`).join("")}`, topic };
}

/** A topic name nobody can guess: anyone who knows a topic on ntfy.sh can read it. */
export function newTopic(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  const letters = "abcdefghijkmnpqrstuvwxyz23456789";
  return `jobauto-${[...random(new Uint8Array(16))].map((byte) => letters[byte % letters.length]).join("")}`;
}
