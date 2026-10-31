import { describe, expect, it } from "vitest";

import { detectAts, hostOf } from "./ats";

describe("the ATS behind a link (Phase A)", () => {
  it.each([
    ["https://acme.jobs.personio.de/job/123456?display=de#apply", "personio"],
    ["https://acme-gmbh.softgarden.io/job/4711/Financial-Analyst", "softgarden"],
    ["https://career5.successfactors.eu/career?company=acme&career_job_req_id=9", "successfactors"],
    ["https://acme.wd3.myworkdayjobs.com/en-US/External/job/Hamburg/Analyst_R-1", "workday"],
    ["https://boards.greenhouse.io/acme/jobs/123", "greenhouse"],
    ["https://job-boards.greenhouse.io/acme/jobs/123", "greenhouse"],
    ["https://jobs.lever.co/acme/1a2b/apply", "lever"],
    ["https://jobs.eu.lever.co/acme/1a2b", "lever"],
    ["https://join.com/companies/acme/123-financial-analyst", "join"],
    ["https://acme.onlyfy.jobs/job/abc", "onlyfy"],
    ["https://acme.dvinci.de/de/p/acme/jobs/1", "dvinci"],
    ["https://recruitingapp-1234.umantis.com/Vacancies/1/Application/New/1", "umantis"],
    ["https://acme.rexx-systems.com/jobs/12", "rexx"],
    ["https://apply.workable.com/acme/j/ABC/apply/", "workable"],
    ["https://jobs.smartrecruiters.com/Acme/7430", "smartrecruiters"],
    ["https://acme.teamtailor.com/jobs/123-analyst/applications/new", "teamtailor"],
    ["https://acme.recruitee.com/o/analyst/c/new", "recruitee"],
    ["https://jobs.ashbyhq.com/acme/uuid/application", "ashby"],
    ["https://www.stepstone.de/stellenangebote--Analyst--123.html", "stepstone"],
    ["https://de.indeed.com/viewjob?jk=abc", "indeed"],
    ["https://www.linkedin.com/jobs/view/123", "linkedin"],
    ["https://www.xing.com/jobs/hamburg-analyst-123", "xing"],
    ["https://www.arbeitsagentur.de/jobsuche/jobdetail/10000-1234567-S", "arbeitsagentur"],
    ["https://karriere.acme.de/stellen/analyst", "unknown"],
    ["", "unknown"],
    ["not a link", "unknown"],
  ])("tells %s is %s", (url, id) => {
    expect(detectAts(url).id).toBe(id);
  });

  it("doesn't take a look-alike host for the real one", () => {
    expect(detectAts("https://notpersonio.de/job/1").id).toBe("unknown");
    expect(detectAts("https://lever.co.example.com/x").id).toBe("unknown");
  });

  it("knows which need an account and which are boards", () => {
    expect(detectAts("https://acme.wd3.myworkdayjobs.com/x")).toMatchObject({ account: true, board: false, autoSubmit: false });
    expect(detectAts("https://www.stepstone.de/x")).toMatchObject({ account: true, board: true });
    expect(detectAts("https://jobs.lever.co/acme/1")).toMatchObject({ account: false, autoSubmit: true, label: "Lever" });
  });

  it("gives the host without www.", () => {
    expect(hostOf("https://www.karriere.acme.de/jobs?x=1")).toBe("karriere.acme.de");
    expect(hostOf("nope")).toBe("");
  });
});
