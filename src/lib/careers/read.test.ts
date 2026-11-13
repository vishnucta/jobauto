import { afterEach, describe, expect, it, vi } from "vitest";

import { boardFor } from "./boards";
import { CareersError, readBoard, workdayPosted } from "./read";

vi.mock("@/lib/posting-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/posting-fetch")>()),
  fetchHtml: vi.fn(async (url: string) => ({ ok: true, url, html: pages[url] ?? "<html><body>No jobs here</body></html>" })),
}));

const pages: Record<string, string> = {};
const answers = new Map<string, () => Response>();
const asked: { url: string; init?: RequestInit }[] = [];

function serve(url: string, body: unknown, status = 200) {
  answers.set(url, () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

afterEach(() => {
  answers.clear();
  asked.length = 0;
  vi.unstubAllGlobals();
});

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      const answer = answers.get(url);
      if (!answer) throw new TypeError("fetch failed");
      return answer();
    }),
  );
}

const PERSONIO = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>1234</id>
    <subcompany>Acme Hamburg GmbH</subcompany>
    <office>Hamburg</office>
    <additionalOffices><additionalOffice>Remote</additionalOffice></additionalOffices>
    <name>Regulatory Reporting Analyst (m/w/d)</name>
    <jobDescriptions>
      <jobDescription>
        <name>Ihre Aufgaben</name>
        <value><![CDATA[<ul><li>EMIR &amp; MiFIR Meldungen</li><li>Abstimmungen</li></ul>]]></value>
      </jobDescription>
    </jobDescriptions>
    <createdAt>2026-11-10T09:00:00+00:00</createdAt>
  </position>
</workzag-jobs>`;

describe("readBoard", () => {
  it("reads Personio's XML feed, with every office and the job's texts", async () => {
    stubFetch();
    serve("https://acme.jobs.personio.de/xml", PERSONIO);
    const [job] = await readBoard(boardFor("https://acme.jobs.personio.de")!, "Acme");
    expect(job).toMatchObject({
      source: "CAREERS",
      externalId: "personio:acme:1234",
      title: "Regulatory Reporting Analyst (m/w/d)",
      company: "Acme Hamburg GmbH",
      place: "Hamburg / Remote",
      postedAt: "2026-11-10T09:00:00.000Z",
      url: "https://acme.jobs.personio.de/job/1234",
      via: "Personio",
    });
    expect(job.description).toBe("Ihre Aufgaben\n- EMIR & MiFIR Meldungen\n- Abstimmungen");
  });

  it("reads Greenhouse's escaped HTML and Lever's lists", async () => {
    stubFetch();
    serve("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true", {
      jobs: [{ id: 7, title: "Fund Accountant", absolute_url: "https://boards.greenhouse.io/acme/jobs/7", location: { name: "Frankfurt" }, updated_at: "2026-11-01T00:00:00Z", content: "&lt;p&gt;Reconcile funds.&lt;/p&gt;" }],
    });
    serve("https://api.lever.co/v0/postings/acme?mode=json", [
      { id: "abc", text: "Reconciliation Lead", hostedUrl: "https://jobs.lever.co/acme/abc", categories: { location: "Hamburg" }, workplaceType: "hybrid", createdAt: 1762041600000, descriptionPlain: "Lead the team.", lists: [{ text: "You bring", content: "<li>SAP</li>" }] },
    ]);
    const [greenhouse] = await readBoard(boardFor("https://boards.greenhouse.io/acme")!, "Acme");
    expect(greenhouse).toMatchObject({ externalId: "greenhouse:acme:7", title: "Fund Accountant", place: "Frankfurt", description: "Reconcile funds.", company: "Acme" });
    const [lever] = await readBoard(boardFor("https://jobs.lever.co/acme")!, "Acme");
    expect(lever).toMatchObject({ title: "Reconciliation Lead", place: "Hamburg", remote: false, description: "Lead the team.\n\nYou bring\n- SAP" });
  });

  it("searches Workday for each word, page by page, once per job", async () => {
    stubFetch();
    const api = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/jobs";
    serve(api, { total: 1, jobPostings: [{ title: "EMIR Analyst", externalPath: "/job/Hamburg/EMIR-Analyst_R100", locationsText: "Hamburg", postedOn: "Posted Today" }] });
    const jobs = await readBoard(boardFor("https://acme.wd3.myworkdayjobs.com/de-DE/Careers")!, "Acme", ["EMIR", "Reporting"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ externalId: "workday:acme/Careers:R100", url: "https://acme.wd3.myworkdayjobs.com/de-DE/Careers/job/Hamburg/EMIR-Analyst_R100", complete: false });
    expect(asked.map(({ init }) => JSON.parse(init!.body as string).searchText)).toEqual(["EMIR", "Reporting"]);
  });

  it("reads JobPosting data on a page of the employer's own, and says when there's none", async () => {
    stubFetch();
    pages["https://www.acme.de/karriere"] = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "JobPosting", title: "Bilanzbuchhalter", url: "https://www.acme.de/karriere/42", identifier: { value: "42" }, hiringOrganization: { name: "Acme AG" }, jobLocation: { address: { addressLocality: "Hamburg", addressCountry: "DE" } }, description: "<p>Abschlüsse nach HGB.</p>" }],
    })}</script></head></html>`;
    const [job] = await readBoard(boardFor("https://www.acme.de/karriere")!, "Acme");
    expect(job).toMatchObject({ externalId: "page:www.acme.de:42", title: "Bilanzbuchhalter", company: "Acme AG", place: "Hamburg, DE", url: "https://www.acme.de/karriere/42", via: "its own page" });
    await expect(readBoard(boardFor("https://www.other.de/jobs")!, "Other")).rejects.toThrow(/can't read the jobs on this page/);
  });

  it("says in words what went wrong", async () => {
    stubFetch();
    serve("https://api.ashbyhq.com/posting-api/job-board/gone", "", 404);
    await expect(readBoard(boardFor("https://jobs.ashbyhq.com/gone")!, "Gone")).rejects.toThrow("The job system doesn't know this careers page. Check its address.");
    await expect(readBoard(boardFor("https://acme.recruitee.com")!, "Acme")).rejects.toThrow(CareersError);
  });
});

describe("workdayPosted", () => {
  const now = new Date("2026-11-13T15:00:00Z");
  it("reads Workday's words as a day", () => {
    expect(workdayPosted("Posted Today", now)).toBe("2026-11-13T00:00:00.000Z");
    expect(workdayPosted("Posted Yesterday", now)).toBe("2026-11-12T00:00:00.000Z");
    expect(workdayPosted("Posted 3 Days Ago", now)).toBe("2026-11-10T00:00:00.000Z");
    expect(workdayPosted("Posted 30+ Days Ago", now)).toBeNull();
  });
});
