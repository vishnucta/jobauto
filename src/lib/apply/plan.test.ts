import { describe, expect, it } from "vitest";

import { planFor } from "./plan";

describe("a copy of the ad (jobauto fork, Apply at the source)", () => {
  it("takes an email address the posting names over a copy of the ad", () => {
    const plan = planFor({ postingUrl: "https://de.jooble.org/jdp/1", postingText: "Bewerbung an jobs@ledgerly.example", posting: null, company: "Ledgerly GmbH" });
    expect(plan).toEqual({ kind: "email", to: "jobs@ledgerly.example" });
  });

  it("keeps the copy as the last resort, and says it is one", () => {
    const plan = planFor({ postingUrl: "https://de.jooble.org/jdp/1", postingText: "Jetzt bewerben.", posting: null, company: "Ledgerly GmbH" });
    expect(plan).toMatchObject({ kind: "web", host: "de.jooble.org", owner: { kind: "copy", site: "Jooble" } });
  });

  it("tells an agency's own site and an unknown site from the employer's", () => {
    expect(planFor({ postingUrl: "https://www.selbyjennings.com/job/1", postingText: "", posting: null, company: "A bank in Hamburg" })).toMatchObject({
      owner: { kind: "agency", site: "Selby Jennings" },
    });
    expect(planFor({ postingUrl: "https://jobs.unknown-board.example/1", postingText: "", posting: null, company: "Ledgerly GmbH" })).toMatchObject({ owner: { kind: "unsure" } });
    expect(planFor({ postingUrl: "https://karriere.ledgerly.de/1", postingText: "", posting: null, company: "Ledgerly GmbH" })).toMatchObject({ owner: null });
  });
});

describe("where an application goes (Phase A)", () => {
  it("takes the employer's own page when there is one", () => {
    const plan = planFor({ postingUrl: "https://karriere.acme.de/jobs/1", postingText: "Bewerbung an jobs@acme.de", posting: null });
    expect(plan).toMatchObject({ kind: "web", host: "karriere.acme.de", ats: { id: "unknown" } });
  });

  it("takes a known ATS link over an email address", () => {
    const plan = planFor({ postingUrl: "https://acme.jobs.personio.de/job/1", postingText: "Fragen an jobs@acme.de", posting: null });
    expect(plan).toMatchObject({ kind: "web", ats: { id: "personio" } });
  });

  it("prefers an email address to a job board's link", () => {
    const plan = planFor({
      postingUrl: "https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1-S",
      postingText: "Ihre Bewerbung senden Sie bitte an bewerbung@acme.de",
      posting: { url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1-S", source: "ARBEITSAGENTUR" },
    });
    expect(plan).toEqual({ kind: "email", to: "bewerbung@acme.de" });
  });

  it("falls back to the board's link without an address", () => {
    const plan = planFor({ postingUrl: "https://www.stepstone.de/stellenangebote--x--1.html", postingText: "Jetzt bewerben.", posting: null });
    expect(plan).toMatchObject({ kind: "web", ats: { id: "stepstone", board: true } });
  });

  it("uses the stored posting's link when the application has none", () => {
    const plan = planFor({ postingUrl: "", postingText: "", posting: { url: "https://jobs.lever.co/acme/1", source: "JSEARCH" } });
    expect(plan).toMatchObject({ kind: "web", ats: { id: "lever" } });
  });

  it("is none without a link or an address", () => {
    expect(planFor({ postingUrl: "", postingText: "Bewerben Sie sich per Post.", posting: null })).toEqual({ kind: "none" });
    expect(planFor({ postingUrl: "file:///C:/x.pdf", postingText: "", posting: null })).toEqual({ kind: "none" });
  });
});
