import "server-only";

import { jobSearchError } from "./errors";
import type { JobSource } from "./search";
import { SOURCE_INFO } from "./sources";

// Requests to job sources (E14-1). Each source has a fixed host, so unlike
// fetching a posting (src/lib/posting-fetch.ts) there's no address to guard;
// requests are still limited in time and size.

export const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Asks a source for JSON, turning every failure into a JobSearchError: a GET,
 * or a POST of `body` as JSON. A source that takes its key in the path gives a
 * `label` to log instead of it.
 */
export async function requestJson(
  source: JobSource,
  url: URL,
  { headers = {}, signal, body, label }: { headers?: Record<string, string>; signal?: AbortSignal; body?: unknown; label?: string } = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const where = label ?? url.pathname;
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
  } catch (error) {
    const reason = timeout.aborted ? "timed out" : ((error as { cause?: { code?: string } }).cause?.code ?? "request failed");
    throw jobSearchError("unavailable", source, { detail: `${where}: ${reason}` });
  }

  const detail = `${where}: HTTP ${response.status}`;
  // A bot check (Cloudflare's "Just a moment…") is no verdict on the key: it turns away a server's request before the source sees it, and isn't got past.
  if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
    throw jobSearchError("unavailable", source, {
      detail: `${detail}, turned away by a bot check`,
      text: `${SOURCE_INFO[source].name}'s site turned this request away with a bot check, so it can't be searched from this server for now. Choose another source in Settings → Job search.`,
    });
  }
  if (response.status === 401 || response.status === 403) throw jobSearchError("key", source, { detail });
  if (response.status === 429) throw jobSearchError("quota", source, { detail });
  if (!response.ok) throw jobSearchError(response.status >= 500 ? "unavailable" : "changed", source, { detail });

  const text = await readLimited(response, MAX_BYTES);
  if (text === null) throw jobSearchError("changed", source, { detail: `${where}: answer over ${MAX_BYTES} bytes` });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw jobSearchError("changed", source, { detail: `${where}: not JSON` });
  }
}

/** The body as text, or null when it's bigger than `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
