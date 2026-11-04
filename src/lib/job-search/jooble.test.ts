import { afterEach, describe, expect, it, vi } from "vitest";

import { json, refused, stubFetch } from "@/lib/ai/test-http";
import { joobleResponse } from "@/test/job-search-fixtures";

import { jooble, radiusFor, updatedAt } from "./jooble";
import { EMPTY_QUERY } from "./search";

const fetchPosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/posting-fetch", () => ({ fetchPosting }));

const query = { ...EMPTY_QUERY, keywords: "financial analyst", place: "Hamburg", country: "de", radiusKm: 25 as const };
const credentials = { key: "jooble-secret-key" };

afterEach(() => {
  vi.unstubAllGlobals();
  fetchPosting.mockReset();
});

describe("Jooble search", () => {
  it("posts the search to the key's address, with the radius Jooble takes", async () => {
    const requests = stubFetch(() => json(joobleResponse));
    await jooble.search(query, credentials, null);
    const [request] = requests;
    expect(request.method).toBe("POST");
    expect(request.url.href).toBe("https://jooble.org/api/jooble-secret-key");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.body).toEqual({ keywords: "financial analyst", location: "Hamburg", radius: "26", page: "1" });
  });

  it("searches the country without a place, adds “remote” to the words, and pages on from the cursor", async () => {
    const requests = stubFetch(() => json(joobleResponse));
    await jooble.search({ ...query, place: "", remoteOnly: true }, credentials, "page:3:40", { baseUrl: "http://127.0.0.1:3998/jooble" });
    const [request] = requests;
    expect(request.url.href).toBe("http://127.0.0.1:3998/jooble/jooble-secret-key");
    expect(request.body).toEqual({ keywords: "financial analyst remote", location: "Germany", page: "3" });
  });

  it("maps results to the shared shape, marked incomplete, with the markup taken out", async () => {
    stubFetch(() => json(joobleResponse));
    const page = await jooble.search(query, credentials, null);
    expect(page.postings).toEqual([
      {
        source: "JOOBLE",
        // From the link: the id in the answer is rounded.
        externalId: "2564425438897072736",
        title: "Senior Financial Analyst (m/w/d)",
        company: "Ledgerly GmbH",
        place: "Hamburg",
        remote: null,
        salary: "65.000 - 80.000 EUR",
        postedAt: "2026-11-02T09:15:00.123Z",
        url: "https://jooble.org/jdp/2564425438897072736",
        // A board it took the posting from; Jooble's own is left out.
        via: "stepstone.de",
        description: "Ledgerly is hiring a Financial Analyst for regulatory reporting ... EMIR and MiFIR",
        complete: false,
      },
      {
        source: "JOOBLE",
        externalId: "88",
        title: "Meldewesen Spezialist",
        company: "",
        place: "Frankfurt am Main",
        remote: null,
        salary: "",
        postedAt: null,
        // javascript: is never a link.
        url: "",
        via: "",
        description: "",
        complete: false,
      },
    ]);
  });

  it("goes on while the pages so far hold fewer results than the total, whatever the page size", async () => {
    stubFetch(() => json(joobleResponse));
    // Four results came back, and 45 are found.
    expect((await jooble.search(query, credentials, null)).next).toBe("page:2:4");
    expect((await jooble.search(query, credentials, "page:2:4")).next).toBe("page:3:8");
    expect((await jooble.search(query, credentials, "page:12:41")).next).toBeNull();
    stubFetch(() => json({ totalCount: 0, jobs: [] }));
    expect((await jooble.search(query, credentials, null)).next).toBeNull();
    // An empty page ends it, however many it promised.
    stubFetch(() => json({ totalCount: 900, jobs: [] }));
    expect((await jooble.search(query, credentials, "page:5:80")).next).toBeNull();
  });

  it("leaves out what changed before the window, as Jooble has no date filter", async () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().replace("Z", "0000");
    stubFetch(() =>
      json({
        totalCount: 3,
        jobs: [
          { id: 1, title: "Fresh", updated: ago(2) },
          { id: 2, title: "Stale", updated: ago(20) },
          { id: 3, title: "Undated", updated: null },
        ],
      }),
    );
    const week = await jooble.search({ ...query, postedWithin: "week" }, credentials, null);
    expect(week.postings.map((posting) => posting.title)).toEqual(["Fresh", "Undated"]);
    const any = await jooble.search(query, credentials, null);
    expect(any.postings).toHaveLength(3);
  });

  it("says the source changed when the answer has an unknown shape", async () => {
    stubFetch(() => json({ error: "Something" }));
    await expect(jooble.search(query, credentials, null)).rejects.toMatchObject({ problem: "changed", detail: "JOOBLE: /api/{key}: unexpected answer" });
  });

  it("says when Jooble refuses the key, and never logs it", async () => {
    stubFetch(() => json({ error: "Access denied" }, { status: 403 }));
    const error = await jooble.search(query, credentials, null).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      problem: "key",
      message: expect.stringContaining("Jooble didn't accept your key. Check it in Settings → Job search"),
      detail: "JOOBLE: /api/{key}: HTTP 403",
    });
    expect(JSON.stringify(error)).not.toContain("jooble-secret-key");
  });

  it("says when the key's searches are used up, and logs a failed request without the key", async () => {
    stubFetch(() => json({}, { status: 429 }));
    await expect(jooble.search(query, credentials, null)).rejects.toMatchObject({
      problem: "quota",
      message: "Your Jooble key has no searches left. Ask Jooble for more at jooble.org/api/about, or choose another source in Settings → Job search.",
    });
    stubFetch(() => refused());
    await expect(jooble.search(query, credentials, null)).rejects.toMatchObject({ problem: "unavailable", detail: "JOOBLE: /api/{key}: ECONNREFUSED" });
  });
});

describe("Jooble details and test", () => {
  it("reads the rest of the posting from its page with the guarded fetcher", async () => {
    fetchPosting.mockResolvedValueOnce({ ok: true, text: "The whole posting.", source: "page", url: "https://de.jooble.org/desc/4721394012" });
    stubFetch(() => json(joobleResponse));
    const [posting] = (await jooble.search(query, credentials, null)).postings;
    expect(await jooble.details(posting, credentials)).toBe("The whole posting.");
    expect(fetchPosting).toHaveBeenCalledWith(posting.url);

    fetchPosting.mockResolvedValueOnce({ ok: false, error: "unreadable" });
    expect(await jooble.details(posting, credentials)).toBeNull();
    expect(await jooble.details({ ...posting, url: "" }, credentials)).toBeNull();
  });

  it("tests the key with one small search, even when the key's country has no jobs for it", async () => {
    const requests = stubFetch(() => json({ totalCount: 0, jobs: [] }));
    await expect(jooble.test(credentials)).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({ keywords: "developer", location: "Berlin" });
  });

  it("fails the test when Jooble refuses the key", async () => {
    stubFetch(() => json({}, { status: 403 }));
    await expect(jooble.test(credentials)).rejects.toMatchObject({ problem: "key" });
  });
});

describe("radiusFor", () => {
  it("takes the smallest radius Jooble allows that reaches as far, and its widest beyond that", () => {
    expect([0, 10, 25, 50, 100, 200].map(radiusFor)).toEqual([0, 16, 26, 80, 80, 80]);
  });
});

describe("updatedAt", () => {
  it("reads Jooble's seven fractional digits, and a missing zone as UTC", () => {
    expect(updatedAt("2023-09-15T12:55:35.3870000")).toBe("2023-09-15T12:55:35.387Z");
    expect(updatedAt("2023-09-15T12:55:35")).toBe("2023-09-15T12:55:35.000Z");
    expect(updatedAt("2023-09-15T12:55:35.5+02:00")).toBe("2023-09-15T10:55:35.500Z");
  });

  it("is null for anything else", () => {
    expect(updatedAt("not a date")).toBeNull();
    expect(updatedAt("")).toBeNull();
    expect(updatedAt(null)).toBeNull();
    expect(updatedAt("2023-13-45T99:99:99")).toBeNull();
  });
});
