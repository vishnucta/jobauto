import { describe, expect, it } from "vitest";

import { boardFor, nameFromBoard } from "./boards";
import { matchesEmployer } from "./match";

describe("boardFor", () => {
  it("knows each job system by its careers page's address", () => {
    expect(boardFor("https://acme-gmbh.jobs.personio.de/?language=de")).toEqual({ kind: "personio", host: "acme-gmbh.jobs.personio.de" });
    expect(boardFor("https://boards.greenhouse.io/acme")).toEqual({ kind: "greenhouse", token: "acme", eu: false });
    expect(boardFor("https://job-boards.eu.greenhouse.io/acme/jobs/123")).toEqual({ kind: "greenhouse", token: "acme", eu: true });
    expect(boardFor("https://boards.greenhouse.io/embed/job_board?for=acme")).toEqual({ kind: "greenhouse", token: "acme", eu: false });
    expect(boardFor("https://jobs.eu.lever.co/acme")).toEqual({ kind: "lever", company: "acme", eu: true });
    expect(boardFor("https://jobs.smartrecruiters.com/AcmeGroup")).toEqual({ kind: "smartrecruiters", company: "AcmeGroup" });
    expect(boardFor("https://acme.recruitee.com/")).toEqual({ kind: "recruitee", slug: "acme" });
    expect(boardFor("https://jobs.ashbyhq.com/acme")).toEqual({ kind: "ashby", name: "acme" });
  });

  it("reads Workday's tenant and site, with or without a language in the path", () => {
    expect(boardFor("https://acme.wd3.myworkdayjobs.com/de-DE/External_Careers")).toEqual({ kind: "workday", origin: "https://acme.wd3.myworkdayjobs.com", tenant: "acme", site: "External_Careers", locale: "de-DE" });
    expect(boardFor("https://acme.wd103.myworkdayjobs.com/Careers/job/Hamburg/Analyst_R1")).toMatchObject({ kind: "workday", site: "Careers", locale: "" });
    expect(boardFor("https://wd3.myworkdaysite.com/en-US/recruiting/acme/Careers")).toEqual({ kind: "workday", origin: "https://wd3.myworkdaysite.com", tenant: "acme", site: "Careers", locale: "en-US" });
  });

  it("reads anything else as a page of the employer's own, and refuses what isn't a web address", () => {
    expect(boardFor("https://www.acme.de/karriere#jobs")).toEqual({ kind: "page", url: "https://www.acme.de/karriere" });
    // A SuccessFactors career site is on the employer's own host: its job feed's address tells it apart.
    expect(boardFor("https://jobs.acme.de/services/rss/job/?locale=en_US&keywords=x")).toEqual({ kind: "successfactors", origin: "https://jobs.acme.de", locale: "en_US" });
    expect(boardFor("https://karriere.acme.de/services/rss/job/")).toEqual({ kind: "successfactors", origin: "https://karriere.acme.de", locale: "de_DE" });
    expect(boardFor("acme.de/karriere")).toBeNull();
    expect(boardFor("ftp://acme.de/")).toBeNull();
  });
});

describe("nameFromBoard", () => {
  it("makes a name to start from", () => {
    expect(nameFromBoard(boardFor("https://acme-gmbh.jobs.personio.de")!)).toBe("Acme Gmbh");
    expect(nameFromBoard(boardFor("https://karriere.nordbank.de/jobs")!)).toBe("Nordbank");
  });
});

describe("matchesEmployer", () => {
  const job = (title: string, place = "Hamburg", remote: boolean | null = null) => ({ title, place, remote });

  it("keeps every job when there are no words or places", () => {
    expect(matchesEmployer(job("Werkstudent Marketing"), { keywords: "", places: "" })).toBe(true);
  });

  it("keeps titles with one of the words: short ones whole, long ones inside German compounds", () => {
    const keywords = "EMIR, Meldewesen, Buchhalter";
    expect(matchesEmployer(job("EMIR Reporting Analyst (m/w/d)"), { keywords, places: "" })).toBe(true);
    expect(matchesEmployer(job("Spezialist Meldewesen"), { keywords, places: "" })).toBe(true);
    expect(matchesEmployer(job("Finanzbuchhalter (w/m/d)"), { keywords, places: "" })).toBe(true);
    expect(matchesEmployer(job("Emirates desk sales"), { keywords, places: "" })).toBe(false);
  });

  it("keeps jobs in one of the places, remote ones with Remote, and those whose place isn't given", () => {
    const places = "Hamburg, Remote";
    expect(matchesEmployer(job("Analyst", "Hamburg, Germany"), { keywords: "", places })).toBe(true);
    expect(matchesEmployer(job("Analyst", "München"), { keywords: "", places })).toBe(false);
    expect(matchesEmployer(job("Analyst", "Berlin", true), { keywords: "", places })).toBe(true);
    expect(matchesEmployer(job("Analyst", ""), { keywords: "", places })).toBe(true);
    expect(matchesEmployer(job("Analyst", "Düsseldorf"), { keywords: "", places: "Dusseldorf" })).toBe(true);
  });
});
