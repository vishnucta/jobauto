import { describe, expect, it } from "vitest";

import { FIELD_EMPLOYERS } from "@/lib/careers/field-employers";

import { adCopySite, bestApplyLink, betterListed, copyMessage, findPostingAt, linkOwner, linkRank, namedLike } from "./link-owner";

// Whose page a posting's link is (jobauto fork, "Apply at the source"). Made-up
// employers and links only.

describe("adCopySite", () => {
  it("names the sites that copy other sites' job ads, with or without www and on a subdomain", () => {
    expect(adCopySite("https://de.jooble.org/jdp/123")).toBe("Jooble");
    expect(adCopySite("https://www.trabajo.org/job-1")).toBe("Trabajo.org");
    expect(adCopySite("https://talents.studysmarter.de/companies/ledgerly/job-1")).toBe("StudySmarter");
    expect(adCopySite("https://partner.studysmarter.de/apply-form/?job_id=1")).toBe("StudySmarter");
    expect(adCopySite("https://www.adzuna.de/details/42")).toBe("Adzuna");
  });

  it("leaves an employer's site, a job system, a look-alike host and a non-link alone", () => {
    expect(adCopySite("https://karriere.ledgerly.de/jobs/1")).toBeNull();
    expect(adCopySite("https://ledgerly.jobs.personio.de/job/1")).toBeNull();
    expect(adCopySite("https://notjooble.org.example/x")).toBeNull();
    expect(adCopySite("not a link")).toBeNull();
  });
});

describe("namedLike", () => {
  it("finds the employer's name in the host, word by word or run together, umlauts written out", () => {
    expect(namedLike("karriere.ledgerly.de", "Ledgerly GmbH")).toBe(true);
    expect(namedLike("nordbank.de", "NORD BANK AG")).toBe(true);
    expect(namedLike("mueller-logistik.de", "Müller Logistik GmbH")).toBe(true);
    expect(namedLike("jobs.example-clearing.com", "Example Clearing Services")).toBe(true);
  });

  it("doesn't count a legal form, a short word or the last part of the host", () => {
    expect(namedLike("jobsite.example", "AG")).toBe(false);
    expect(namedLike("ab.example", "AB Clearing Partners")).toBe(false);
    expect(namedLike("jobs.de", "De")).toBe(false);
    expect(namedLike("anothersite.example", "Ledgerly GmbH")).toBe(false);
  });
});

describe("linkOwner", () => {
  it("calls a copy of the ad one, whoever the employer", () => {
    expect(linkOwner("https://de.jooble.org/jdp/1", "Ledgerly GmbH")).toEqual({ kind: "copy", site: "Jooble" });
    expect(linkOwner("https://www.learn4good.com/jobs/1/", "")).toEqual({ kind: "copy", site: "learn4good" });
  });

  it("knows an agency's own site, which is no copy", () => {
    expect(linkOwner("https://www.selbyjennings.com/job/1", "A bank in Hamburg")).toEqual({ kind: "agency", site: "Selby Jennings" });
    expect(linkOwner("https://www.michaelpage.de/job-detail/1", "Michael Page")).toEqual({ kind: "agency", site: "Michael Page" });
  });

  it("is unsure of a site it doesn't know that isn't named like the employer", () => {
    expect(linkOwner("https://jobs.unknown-board.example/1", "Ledgerly GmbH")).toEqual({ kind: "unsure" });
  });

  it("says nothing of the employer's own site, a known job system, a job board, or a link with no employer to compare", () => {
    expect(linkOwner("https://karriere.ledgerly.de/jobs/1", "Ledgerly GmbH")).toBeNull();
    expect(linkOwner("https://ledgerly.jobs.personio.de/job/1", "Northwind")).toBeNull();
    expect(linkOwner("https://www.stepstone.de/stellenangebote--x--1.html", "Northwind")).toBeNull();
    expect(linkOwner("https://jobs.unknown-board.example/1", "")).toBeNull();
    expect(linkOwner("https://jobs.unknown-board.example/1", "GmbH")).toBeNull();
    expect(linkOwner("", "Ledgerly GmbH")).toBeNull();
  });
});

describe("findPostingAt", () => {
  it("opens the careers page of an employer she follows, matched without the legal form", () => {
    const followed = [{ name: "Ledgerly", careersUrl: "https://karriere.ledgerly.de" }];
    expect(findPostingAt("Ledgerly GmbH", "Regulatory Reporting Analyst (m/w/d)", followed)).toEqual({
      href: "https://karriere.ledgerly.de",
      via: "careers",
      employer: "Ledgerly GmbH",
    });
  });

  it("opens the careers page of an employer in her field's list", () => {
    const [first] = FIELD_EMPLOYERS;
    expect(findPostingAt(first.name, "Analyst", [])).toMatchObject({ href: first.careersUrl, via: "careers" });
  });

  it("else searches the web for the company, the role without its gender mark, and Karriere", () => {
    const find = findPostingAt("Northwind Clearing GmbH", "Transaction Reporting Analyst (m/w/d)", []);
    expect(find.via).toBe("search");
    expect(new URL(find.href).hostname).toBe("www.google.com");
    expect(new URL(find.href).searchParams.get("q")).toBe("Northwind Clearing GmbH Transaction Reporting Analyst Karriere");
  });

  it("searches with the role alone when the employer isn't named", () => {
    expect(new URL(findPostingAt("", "Reconciliation Specialist", []).href).searchParams.get("q")).toBe("Reconciliation Specialist Karriere");
  });
});

describe("copyMessage", () => {
  it("names the site and says what to do instead", () => {
    expect(copyMessage("Jooble")).toMatch(/copy of the ad on Jooble/);
    expect(copyMessage("Jooble")).toMatch(/paste its link on the Apply tab/);
  });
});

describe("linkRank and bestApplyLink (jobauto fork, Keep every apply option)", () => {
  const company = "Ledgerly GmbH";
  it("ranks the employer's own site and its job system first, then an agency, a job board, a site it can't place, and a copy last", () => {
    expect(linkRank({ url: "https://karriere.ledgerly.de/jobs/7" }, company)).toBe(0);
    expect(linkRank({ url: "https://ledgerly.wd3.myworkdayjobs.com/jobs/7" }, company)).toBe(0);
    expect(linkRank({ url: "https://www.selbyjennings.com/job/7" }, company)).toBe(1);
    expect(linkRank({ url: "https://www.stepstone.de/stellenangebote--7.html" }, company)).toBe(2);
    expect(linkRank({ url: "https://jobs.unknown-board.example/7" }, company)).toBe(3);
    expect(linkRank({ url: "https://de.jooble.org/jdp/7" }, company)).toBe(4);
    expect(linkRank({ url: "mailto:jobs@ledgerly.example" }, company)).toBeNull();
    expect(linkRank({ url: "" }, company)).toBeNull();
  });

  it("counts a site the portal names after the employer as the employer's, and can't place an unknown site with no employer", () => {
    expect(linkRank({ url: "https://careers-portal.example/7", name: "Ledgerly Careers" }, company)).toBe(0);
    expect(linkRank({ url: "https://careers-portal.example/7", name: "Careers" }, company)).toBe(3);
    expect(linkRank({ url: "https://karriere.ledgerly.de/jobs/7" }, "")).toBe(3);
  });

  it("chooses the best-ranked, the first on a tie, and nothing from no web address", () => {
    const options = [
      { name: "Jooble", url: "https://de.jooble.org/jdp/7" },
      { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/7" },
      { name: "Ledgerly Careers", url: "https://ledgerly.jobs.personio.de/job/7" },
    ];
    expect(bestApplyLink(options, company)).toBe("https://ledgerly.jobs.personio.de/job/7");
    expect(bestApplyLink(options.slice(0, 2), company)).toBe("https://www.linkedin.com/jobs/view/7");
    expect(bestApplyLink([{ name: "StepStone", url: "https://www.stepstone.de/a" }, { name: "Indeed", url: "https://de.indeed.com/b" }], company)).toBe("https://www.stepstone.de/a");
    expect(bestApplyLink([{ name: "", url: "not a link" }], company)).toBe("");
  });

  it("offers the other places instead of a copy, best first, never another copy or the link itself", () => {
    const options = [
      { name: "Jooble", url: "https://de.jooble.org/jdp/7" },
      { name: "Trabajo.org", url: "https://www.trabajo.org/job-7" },
      { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/7" },
      { name: "Ledgerly Careers", url: "https://karriere.ledgerly.de/jobs/7" },
    ];
    expect(betterListed(options, "https://de.jooble.org/jdp/7", company)).toEqual([
      { name: "Ledgerly Careers", url: "https://karriere.ledgerly.de/jobs/7" },
      { name: "LinkedIn", url: "https://www.linkedin.com/jobs/view/7" },
    ]);
    expect(betterListed([], "https://de.jooble.org/jdp/7", company)).toEqual([]);
  });
});
