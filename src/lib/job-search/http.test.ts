import { afterEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";

import { requestJson } from "./http";

const url = new URL("https://jobs.example/api/search?q=designer");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requestJson", () => {
  it("returns the parsed answer and asks for JSON", async () => {
    const requests = stubFetch(() => json({ ok: true }));
    expect(await requestJson("JSEARCH", url, { headers: { "x-api-key": "k" } })).toEqual({ ok: true });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.get("accept")).toBe("application/json");
    expect(requests[0].headers.get("x-api-key")).toBe("k");
  });

  it("posts a JSON body, and logs a label instead of a path that holds a key", async () => {
    const requests = stubFetch(() => json({}, { status: 500 }));
    const withKey = new URL("https://jobs.example/api/secret-key");
    await expect(requestJson("JOOBLE", withKey, { body: { page: "1" }, label: "/api/{key}" })).rejects.toMatchObject({ detail: "JOOBLE: /api/{key}: HTTP 500" });
    expect(requests[0]).toMatchObject({ method: "POST", body: { page: "1" } });
    expect(requests[0].headers.get("content-type")).toBe("application/json");
  });

  it("says a bot check turned the request away, not that the key is wrong", async () => {
    stubFetch(() => new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge", "content-type": "text/html" } }));
    await expect(requestJson("JOOBLE", new URL("https://jobs.example/api/secret-key"), { body: {}, label: "/api/{key}" })).rejects.toMatchObject({
      problem: "unavailable",
      message: "Jooble's site turned this request away with a bot check, so it can't be searched from this server for now. Choose another source in Settings → Job search.",
      detail: "JOOBLE: /api/{key}: HTTP 403, turned away by a bot check",
    });
    // Without the check, a 403 is still the key.
    stubFetch(() => json({}, { status: 403 }));
    await expect(requestJson("JOOBLE", url)).rejects.toMatchObject({ problem: "key" });
  });

  it("names the path and status for the log, never the search", async () => {
    stubFetch(() => json({}, { status: 500 }));
    await expect(requestJson("ADZUNA", url)).rejects.toMatchObject({ problem: "unavailable", detail: "ADZUNA: /api/search: HTTP 500" });
  });

  it("says the source changed when the answer isn't JSON", async () => {
    stubFetch(() => new Response("<html>Moved</html>", { status: 200 }));
    await expect(requestJson("ARBEITSAGENTUR", url)).rejects.toMatchObject({ problem: "changed", detail: "ARBEITSAGENTUR: /api/search: not JSON" });
  });

  it("refuses answers over 5 MB", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < 6; index++) controller.enqueue(chunk);
              controller.close();
            },
          }),
        ),
    );
    await expect(requestJson("JSEARCH", url)).rejects.toMatchObject({ problem: "changed", detail: expect.stringContaining("answer over") });
  });

  it("reads an empty body as empty, which isn't JSON", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(requestJson("JSEARCH", url)).rejects.toMatchObject({ problem: "changed" });
  });

  it("says it timed out when the source takes too long", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    stubFetch((_, signal) => Promise.reject(signal?.reason ?? new Error("aborted")));
    await expect(requestJson("JSEARCH", url)).rejects.toMatchObject({ problem: "unavailable", detail: "JSEARCH: /api/search: timed out" });
  });

  it("gives up when the caller does", async () => {
    const caller = new AbortController();
    caller.abort();
    stubFetch((_, signal) => Promise.reject(signal?.reason ?? new Error("aborted")));
    await expect(requestJson("JSEARCH", url, { signal: caller.signal })).rejects.toMatchObject({
      problem: "unavailable",
      detail: "JSEARCH: /api/search: request failed",
    });
  });
});
