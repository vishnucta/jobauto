import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, refused, stubFetch } from "@/lib/ai/test-http";
import { serpapiKeyError, serpapiLastPage, serpapiNoResults, serpapiPage } from "@/test/job-search-fixtures";

import { JobSearchError } from "./errors";
import { EMPTY_QUERY, type SearchQuery } from "./search";
import { daysAgo, languageFor, serpapi } from "./serpapi";

const query: SearchQuery = { ...EMPTY_QUERY, keywords: "product designer", place: "Hamburg", country: "de", radiusKm: 50, postedWithin: "week" };
const key = { key: "serp_test" };
const NOW = new Date("2026-10-04T10:00:00.000Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SerpApi search", () => {
  it("asks the google_jobs engine with the key, place, country and radius, in the country's language", async () => {
    const requests = stubFetch(() => json(serpapiPage));
    await serpapi.search(query, key, null);
    const [{ url }] = requests;
    expect(`${url.origin}${url.pathname}`).toBe("https://serpapi.com/search.json");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      engine: "google_jobs",
      q: "product designer in Hamburg",
      gl: "de",
      hl: "de",
      lrad: "50",
      api_key: "serp_test",
    });
  });

  it("speaks each country's language, since Google has no jobs for Germany in English; English where that's the working language", () => {
    expect(["de", "at", "ch"].map(languageFor)).toEqual(["de", "de", "de"]);
    expect(["fr", "nl", "be", "es", "it", "pl", "se"].map(languageFor)).toEqual(["fr", "nl", "nl", "es", "it", "pl", "sv"]);
    expect(["", "us", "gb", "ie", "au", "in", "sg", "ae", "za"].map(languageFor)).toEqual(["en", "en", "en", "en", "en", "en", "en", "en", "en"]);
    // Google's own codes where they differ, and Luxembourg's French rather than Luxembourgish.
    expect(["no", "il", "lu", "cn", "tw"].map(languageFor)).toEqual(["no", "iw", "fr", "zh-CN", "zh-TW"]);
  });

  it("asks for remote work in the query, sends no radius without a place, and pages by token", async () => {
    const requests = stubFetch(() => json(serpapiPage));
    const page = await serpapi.search({ ...query, place: "", remoteOnly: true, postedWithin: "any" }, key, null);
    expect(requests[0].url.searchParams.get("q")).toBe("product designer remote");
    expect(requests[0].url.searchParams.has("lrad")).toBe(false);
    expect(page.next).toBe("TOKEN-PAGE-2");
    expect(page.postings).toHaveLength(2);
  });

  it("searches the US, in English, when no country is chosen, as Google would anyway", async () => {
    const requests = stubFetch(() => json(serpapiLastPage));
    await serpapi.search({ ...query, country: "" }, key, null);
    expect(requests[0].url.searchParams.get("gl")).toBe("us");
    expect(requests[0].url.searchParams.get("hl")).toBe("en");
  });

  it("maps postings to the shared shape, once each, with Google's id and the employer's own link", async () => {
    stubFetch(() => json(serpapiPage));
    const page = await serpapi.search(query, key, null);
    expect(page.next).toBe("TOKEN-PAGE-2");
    expect(page.postings).toEqual([
      {
        source: "SERPAPI",
        externalId: "LEDGERLY-42",
        title: "Senior Product Designer, Payments",
        company: "Ledgerly",
        place: "Hamburg, Germany",
        remote: null,
        salary: "75K–90K a year",
        postedAt: "2026-09-30T10:00:00.000Z",
        url: "https://careers.ledgerly.example/jobs/42",
        via: "LinkedIn",
        description: expect.stringContaining("Senior Product Designer for its payments team"),
        complete: true,
      },
      {
        source: "SERPAPI",
        externalId: sha("not-base64-json"),
        title: "UX Researcher",
        company: "Northwind Studio",
        place: "Anywhere",
        remote: true,
        salary: "",
        postedAt: "2026-10-04T08:00:00.000Z",
        url: "https://de.indeed.com/viewjob?jk=abc123&from=serp",
        via: "Indeed",
        description: "Northwind Studio is looking for a UX Researcher, fully remote within Germany.",
        complete: true,
      },
    ]);
  });

  it("reads what Google writes in German under a posting: its age, remote work and pay", async () => {
    stubFetch(() =>
      json({
        jobs_results: [
          {
            job_id: "g",
            title: "Financial Analyst (m/w/d)",
            company_name: "Hafenlogik GmbH",
            location: "Hamburg",
            via: "Stepstone",
            description: "Wir suchen einen Financial Analyst für unser Team in Hamburg.",
            extensions: ["vor 5 Tagen", "Vollzeit", "Homeoffice", "60.000–70.000 € pro Jahr"],
            apply_options: [{ title: "Stepstone", link: "https://www.stepstone.de/stellenangebote--1" }],
          },
        ],
      }),
    );
    const [posting] = (await serpapi.search(query, key, null)).postings;
    expect(posting).toMatchObject({
      title: "Financial Analyst (m/w/d)",
      company: "Hafenlogik GmbH",
      place: "Hamburg",
      via: "Stepstone",
      remote: true,
      salary: "60.000–70.000 € pro Jahr",
      postedAt: "2026-09-29T10:00:00.000Z",
      url: "https://www.stepstone.de/stellenangebote--1",
      complete: true,
    });
  });

  it("keeps postings within the time asked for, and those without an age, since Google no longer filters by date", async () => {
    stubFetch(() => json(serpapiPage));
    const day = await serpapi.search({ ...query, postedWithin: "day" }, key, null);
    expect(day.postings.map((posting) => posting.title)).toEqual(["UX Researcher"]);

    const old = { ...serpapiPage.jobs_results[0], job_id: "old", extensions: ["vor 30+ Tagen"], detected_extensions: {} };
    const undated = { ...serpapiPage.jobs_results[0], job_id: "undated", extensions: ["Vollzeit"], detected_extensions: {} };
    stubFetch(() => json({ jobs_results: [old, undated] }));
    const month = await serpapi.search({ ...query, postedWithin: "month" }, key, null);
    expect(month.postings.map((posting) => [posting.externalId, posting.postedAt])).toEqual([[sha("undated"), null]]);
    const any = await serpapi.search({ ...query, postedWithin: "any" }, key, null);
    expect(any.postings.map((posting) => posting.postedAt)).toEqual([null, null]);
    expect(any.next).toBeNull();
  });

  it("sends the token for the next page and stops when there's none", async () => {
    const requests = stubFetch(() => json(serpapiLastPage));
    const page = await serpapi.search(query, key, "TOKEN-PAGE-2");
    expect(requests[0].url.searchParams.get("next_page_token")).toBe("TOKEN-PAGE-2");
    expect(page.next).toBeNull();
  });

  it("takes Google's 'no results' for an empty page, by its state or its error, and anything else it says for a change", async () => {
    stubFetch(() => json(serpapiNoResults));
    expect(await serpapi.search(query, key, null)).toEqual({ postings: [], next: null });
    stubFetch(() => json({ search_metadata: { status: "Success" }, search_information: { jobs_results_state: "Fully empty" } }));
    expect(await serpapi.search(query, key, null)).toEqual({ postings: [], next: null });
    stubFetch(() => json({ search_metadata: { status: "Error" }, error: "Unsupported `location` parameter." }));
    await expect(serpapi.search(query, key, null)).rejects.toMatchObject({ problem: "changed", detail: "SERPAPI: /search.json: error" });
  });

  it("goes to the fake source's address when one is given", async () => {
    const requests = stubFetch(() => json(serpapiLastPage));
    await serpapi.search(query, key, null, { baseUrl: "http://127.0.0.1:3998/serpapi" });
    expect(requests[0].url.href).toMatch(/^http:\/\/127\.0\.0\.1:3998\/serpapi\/search\.json\?/);
  });

  it("drops links that aren't web addresses, and reads remote work from the extensions", async () => {
    stubFetch(() =>
      json({
        jobs_results: [
          { job_id: "x", title: "Designer", share_link: "javascript:alert(1)", apply_options: [{ title: "Careers", link: "data:text/html,hi" }], extensions: ["Work from home"] },
          { job_id: "y", title: " Spaced  ", company_name: "Co", location: "Berlin,  Germany", via: "via XING", description: "", detected_extensions: { posted_at: "Just posted" } },
        ],
      }),
    );
    const [first, second] = (await serpapi.search({ ...query, postedWithin: "any" }, key, null)).postings;
    expect(first).toMatchObject({ url: "", remote: true, postedAt: null, salary: "", via: "", complete: false });
    expect(second).toMatchObject({ title: "Spaced", place: "Berlin, Germany", via: "XING", remote: null, postedAt: "2026-10-04T10:00:00.000Z" });
  });

  it.each([
    [401, "key"],
    [403, "key"],
    [429, "quota"],
    [503, "unavailable"],
    [404, "changed"],
  ] as const)("turns HTTP %i into a %s problem", async (status, problem) => {
    stubFetch(() => json(serpapiKeyError, { status }));
    await expect(serpapi.search(query, key, null)).rejects.toMatchObject({ name: "JobSearchError", problem });
  });

  it("says the source changed when the answer has an unknown shape", async () => {
    stubFetch(() => json({ jobs_results: "none" }));
    const error = await serpapi.search(query, key, null).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobSearchError);
    expect(error).toMatchObject({ problem: "changed", detail: "SERPAPI: /search.json: unexpected answer" });
  });

  it("says the source isn't answering when it can't be reached", async () => {
    stubFetch(refused);
    await expect(serpapi.search(query, key, null)).rejects.toMatchObject({
      problem: "unavailable",
      message: "SerpApi isn't answering right now. Try again in a minute.",
      detail: "SERPAPI: /search.json: ECONNREFUSED",
    });
  });
});

describe("how long ago Google says a posting went up, in its languages", () => {
  it.each([
    ["Just posted", 0],
    ["Today", 0],
    ["Yesterday", 1],
    ["2 hours ago", 2 / 24],
    ["4 days ago", 4],
    ["1 week ago", 7],
    ["30+ days ago", 31],
    ["vor 5 Tagen", 5],
    ["vor 2 Stunden", 2 / 24],
    ["vor über 30 Tagen", 31],
    ["gestern", 1],
    ["heute", 0],
    ["il y a 3 jours", 3],
    ["3 dagen geleden", 3],
    ["hace 2 semanas", 14],
    ["2 giorni fa", 2],
    ["há 1 mês", 30],
    ["2 dni temu", 2],
    ["för 5 dagar sedan", 5],
    ["", null],
    ["Full-time", null],
    ["Vollzeit", null],
    ["25 € pro Stunde", null],
  ])("reads %j as %s days", (text, days) => {
    expect(daysAgo(text)).toBe(days);
  });
});

describe("SerpApi details and test", () => {
  it("has the whole description already, so details never asks again", async () => {
    const requests = stubFetch(() => json(serpapiPage));
    const [posting] = (await serpapi.search(query, key, null)).postings;
    expect(await serpapi.details(posting, key)).toBe(posting.description);
    expect(await serpapi.details({ ...posting, description: "" }, key)).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("tests the key with one small search, and takes no jobs at all for a request Google doesn't understand", async () => {
    const requests = stubFetch(() => json(serpapiLastPage));
    await serpapi.test(key);
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0].url.searchParams)).toMatchObject({ q: "developer", gl: "us", hl: "en", api_key: "serp_test" });
    stubFetch(() => json(serpapiNoResults));
    await expect(serpapi.test(key)).rejects.toMatchObject({ problem: "changed", detail: "SERPAPI: /search.json: nothing for the test search" });
  });
});
