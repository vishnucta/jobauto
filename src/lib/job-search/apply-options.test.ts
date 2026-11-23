import { describe, expect, it } from "vitest";

import { agentDedupeKey, agentDedupeKeys } from "@/lib/agent/candidates";
import { sameJob } from "@/lib/dedupe";

import { cleanOptions, linkKeysOf, mergedOptions, optionsFromColumn, otherOptions, withApplyOptions } from "./apply-options";
import { jobKeys, MAX_APPLY_OPTIONS, type FoundPosting } from "./search";

// Every place a portal lists to apply at (jobauto fork, "Keep every apply
// option"). Made-up employers and links only.

const posting = (extra: Partial<FoundPosting> = {}): FoundPosting => ({
  source: "JSEARCH",
  externalId: "job-1",
  title: "Regulatory Reporting Analyst",
  company: "Ledgerly GmbH",
  place: "Hamburg",
  remote: null,
  salary: "",
  postedAt: null,
  url: "https://de.jooble.org/jdp/1",
  via: "Jooble",
  description: "",
  complete: false,
  ...extra,
});
const careers = { name: "Ledgerly Careers", url: "https://ledgerly.jobs.personio.de/job/1" };
const linkedin = { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1" };
const copy = { name: "Jooble", url: "https://de.jooble.org/jdp/1" };

describe("cleanOptions", () => {
  it("keeps web addresses only, each link once whatever its tracking, names trimmed, at most twelve", () => {
    expect(
      cleanOptions([
        { name: " LinkedIn ", url: "https://www.linkedin.com/jobs/view/1?utm_source=google" },
        { name: "LinkedIn again", url: "https://linkedin.com/jobs/view/1" },
        { name: "Mail", url: "mailto:jobs@ledgerly.example" },
        { name: null, url: "https://careers.ledgerly.example/1" },
        { url: null },
      ]),
    ).toEqual([
      { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/1?utm_source=google" },
      { name: "", url: "https://careers.ledgerly.example/1" },
    ]);
    expect(cleanOptions(Array.from({ length: 20 }, (_, index) => ({ name: "", url: `https://jobs.example/${index}` })))).toHaveLength(MAX_APPLY_OPTIONS);
  });
});

describe("withApplyOptions (the link chosen when a posting is found)", () => {
  it("takes the employer's own over the portal's pick when that is a copy, and keeps every option, its own first", () => {
    const found = withApplyOptions(posting(), [copy, linkedin, careers]);
    expect(found.url).toBe(careers.url);
    expect(found.applyOptions).toEqual([copy, linkedin, careers]);
  });

  it("takes a job board over a copy, and an agency's own site over a board", () => {
    expect(withApplyOptions(posting(), [copy, linkedin]).url).toBe(linkedin.url);
    const agency = { name: "Selby Jennings", url: "https://www.selbyjennings.com/job/1" };
    expect(withApplyOptions(posting({ url: linkedin.url }), [linkedin, agency]).url).toBe(agency.url);
  });

  it("keeps the portal's pick on a tie, and leaves a posting as it was when the portal lists nothing else", () => {
    const board = { name: "StepStone", url: "https://www.stepstone.de/stellenangebote--1.html" };
    expect(withApplyOptions(posting({ url: linkedin.url }), [board, linkedin]).url).toBe(linkedin.url);
    const alone = posting({ url: linkedin.url });
    expect(withApplyOptions(alone, [linkedin])).toBe(alone);
    expect(withApplyOptions(alone, [])).toBe(alone);
  });

  it("names its own link as the list names it, not by where the portal found the posting", () => {
    expect(withApplyOptions(posting({ url: careers.url, via: "LinkedIn" }), [linkedin, careers]).applyOptions?.[0]).toEqual(careers);
  });

  it("gives a posting with no link of its own the best of the list", () => {
    expect(withApplyOptions(posting({ url: "" }), [copy, careers])).toMatchObject({ url: careers.url, applyOptions: [copy, careers] });
  });
});

describe("mergedOptions (a kept posting found again)", () => {
  it("keeps the link it has first, adds the places found now, and names the link from either list", () => {
    expect(mergedOptions({ url: copy.url, applyOptions: null }, { applyOptions: [linkedin, careers, copy] })).toEqual([copy, linkedin, careers]);
    expect(mergedOptions({ url: copy.url, applyOptions: [copy, linkedin] }, { applyOptions: [careers] })).toEqual([copy, linkedin, careers]);
  });

  it("is nothing when neither has any", () => {
    expect(mergedOptions({ url: copy.url, applyOptions: null }, {})).toBeUndefined();
  });
});

describe("the links a posting is known by", () => {
  it("are its own and every place it's listed at, each once", () => {
    expect(linkKeysOf({ url: careers.url, applyOptions: [copy, careers] })).toEqual(["ledgerly.jobs.personio.de/job/1", "de.jooble.org/jdp/1"]);
    expect(linkKeysOf({ url: "" })).toEqual([]);
    expect(otherOptions({ url: careers.url, applyOptions: [copy, careers, linkedin] })).toEqual([copy, linkedin]);
  });

  it("are read back from the stored column, and nothing from what isn't a list of them", () => {
    expect(optionsFromColumn([copy, { name: 1 }, "x", careers])).toEqual([copy, careers]);
    expect(optionsFromColumn(null)).toBeUndefined();
    expect(optionsFromColumn([])).toBeUndefined();
    expect(optionsFromColumn({ url: careers.url })).toBeUndefined();
  });

  it("match a job already known by a link it no longer leads with (add_found_jobs, careers pages)", () => {
    expect(jobKeys({ ...posting({ url: careers.url }), applyOptions: [copy, careers] })).toContain("link:de.jooble.org/jdp/1");
    expect(jobKeys(posting({ url: careers.url }))).not.toContain("link:de.jooble.org/jdp/1");
  });

  it("match the job agent's candidate kept under the old link, its own key unchanged", () => {
    const before = posting();
    const now = withApplyOptions(posting(), [copy, careers]);
    expect(agentDedupeKeys(now)[0]).toBe(agentDedupeKey(now));
    expect(agentDedupeKeys(now)).toContain(agentDedupeKey(before));
    expect(agentDedupeKeys(before)).toEqual([agentDedupeKey(before)]);
  });

  it("merge the same job from two portals that share any link (the library's layer 2)", () => {
    const fromJsearch = { ...withApplyOptions(posting(), [copy, careers]), description: "" };
    const fromOther = { ...posting({ source: "ADZUNA", externalId: "a-1" }), url: copy.url };
    expect(fromJsearch.url).not.toBe(fromOther.url);
    expect(sameJob(fromOther, fromJsearch)).toBe(2);
    // Another company's posting at the same link is never the same job.
    expect(sameJob({ ...fromOther, company: "Northwind" }, fromJsearch)).toBeNull();
  });
});
