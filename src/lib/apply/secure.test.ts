import { describe, expect, it } from "vitest";

import { isSecure, openPreferringHttps, secured, upgraded, type Navigable } from "./secure";

/** A page that answers by a rule: for an address it goes to another one, or fails. */
function fakePage(start: string, answer: (url: string) => string | Error) {
  const visited: string[] = [];
  let current = start;
  const page: Navigable = {
    url: () => current,
    goto: async (url) => {
      visited.push(url);
      const result = answer(url);
      if (result instanceof Error) throw result;
      current = result;
    },
    waitForTimeout: async () => {},
  };
  return { page, visited };
}

describe("isSecure", () => {
  it("allows https, and this computer", () => {
    expect(isSecure("https://www.learn4good.com/jobs/1/")).toBe(true);
    expect(isSecure("http://localhost:3000/form")).toBe(true);
    expect(isSecure("http://127.0.0.1:8080/")).toBe(true);
    expect(isSecure("http://[::1]:8080/")).toBe(true);
    expect(isSecure("http://test.localhost/")).toBe(true);
  });

  it("refuses http, other schemes and anything that isn't an address", () => {
    expect(isSecure("http://www.learn4good.com/jobs/1/")).toBe(false);
    expect(isSecure("http://localhost.example.com/")).toBe(false);
    expect(isSecure("http://127.0.0.1.example.com/")).toBe(false);
    expect(isSecure("ftp://example.com/")).toBe(false);
    expect(isSecure("file:///C:/form.html")).toBe(false);
    expect(isSecure("about:blank")).toBe(false);
    expect(isSecure("www.learn4good.com/jobs/1/")).toBe(false);
    expect(isSecure("")).toBe(false);
  });
});

describe("upgraded", () => {
  it("turns an http address into https, keeping the rest", () => {
    expect(upgraded("http://www.learn4good.com/jobs/frankfurt/5578565302/g/?a=1#apply")).toBe("https://www.learn4good.com/jobs/frankfurt/5578565302/g/?a=1#apply");
  });

  it("leaves everything else as it was", () => {
    for (const url of ["https://example.com/a", "http://localhost:3000/a", "http://example.com:8080/a", "ftp://example.com/", "not an address", ""]) {
      expect(upgraded(url)).toBe(url);
    }
  });
});

describe("openPreferringHttps", () => {
  it("opens an http address as https", async () => {
    const { page, visited } = fakePage("about:blank", (url) => url);
    expect(await openPreferringHttps(page, "http://example.com/job")).toBe(true);
    expect(visited).toEqual(["https://example.com/job"]);
  });

  it("opens an https address once, as it is", async () => {
    const { page, visited } = fakePage("about:blank", (url) => url);
    expect(await openPreferringHttps(page, "https://example.com/job")).toBe(true);
    expect(visited).toEqual(["https://example.com/job"]);
  });

  it("falls back to the address as given when https doesn't answer", async () => {
    const { page, visited } = fakePage("about:blank", (url) => (url.startsWith("https:") ? new Error("net::ERR_CONNECTION_REFUSED") : url));
    expect(await openPreferringHttps(page, "http://example.com/job")).toBe(true);
    expect(visited).toEqual(["https://example.com/job", "http://example.com/job"]);
    // It opened, but not encrypted: the run refuses to type into it.
    expect(isSecure(page.url())).toBe(false);
  });

  it("says so when neither opens", async () => {
    const { page, visited } = fakePage("about:blank", () => new Error("timeout"));
    expect(await openPreferringHttps(page, "http://example.com/job")).toBe(false);
    expect(visited).toHaveLength(2);
    expect(await openPreferringHttps(page, "https://example.com/job")).toBe(false);
  });
});

describe("secured", () => {
  it("lets an encrypted page be, without opening anything", async () => {
    const { page, visited } = fakePage("https://example.com/form", (url) => url);
    expect(await secured(page)).toBe(true);
    expect(visited).toEqual([]);
  });

  it("opens an http page again as https", async () => {
    const { page, visited } = fakePage("http://example.com/form", (url) => url);
    expect(await secured(page)).toBe(true);
    expect(visited).toEqual(["https://example.com/form"]);
    expect(page.url()).toBe("https://example.com/form");
  });

  it("says no when the site sends the visitor back to http", async () => {
    const { page } = fakePage("http://example.com/form", (url) => url.replace("https:", "http:"));
    expect(await secured(page)).toBe(false);
    expect(page.url()).toBe("http://example.com/form");
  });

  it("says no when https doesn't answer, and leaves the page where it was", async () => {
    const { page } = fakePage("http://example.com/form", () => new Error("net::ERR_SSL_PROTOCOL_ERROR"));
    expect(await secured(page)).toBe(false);
    expect(page.url()).toBe("http://example.com/form");
  });

  it("says no for an http address it can't upgrade, such as one with its own port, and doesn't try", async () => {
    const { page, visited } = fakePage("http://example.com:8080/form", (url) => url);
    expect(await secured(page)).toBe(false);
    expect(visited).toEqual([]);
  });

  it("lets a form on this computer be, as the test form is", async () => {
    const { page, visited } = fakePage("http://localhost:3000/apply-form.html", (url) => url);
    expect(await secured(page)).toBe(true);
    expect(visited).toEqual([]);
  });
});
