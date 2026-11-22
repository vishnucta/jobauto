import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boardFor } from "./boards";
import { CareersError, politeness, readBoard, workdayPosted } from "./read";

vi.mock("@/lib/posting-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/posting-fetch")>()),
  fetchHtml: vi.fn(async (url: string) => ({ ok: true, url, html: pages[url] ?? "<html><body>No jobs here</body></html>" })),
}));

const pages: Record<string, string> = {};
const answers = new Map<string, () => Response>();
const asked: { url: string; init?: RequestInit }[] = [];

// No pauses between requests in tests.
beforeEach(() => Object.assign(politeness, { pauseMs: 0, retryMs: 0 }));

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

const SUCCESSFACTORS = `<?xml version="1.0" encoding="UTF-8" ?><rss version='2.0'><channel><title>Acme - Individuelle Suche Reporting</title>
<item><title><![CDATA[Regulatory Reporting Analyst (w/m/d) (Frankfurt, DE, 60549)]]></title><description><![CDATA[<p>Meldewesen &amp; COREP.</p>]]></description><pubDate>Fri, 20 Nov 2026 2:00:00 GMT</pubDate><link>https://jobs.acme.de/job/Frankfurt-Regulatory-Reporting-Analyst-60549/995106401/?feedId=null&amp;utm_source=J2WRSS&amp;utm_medium=rss</link></item>
<item><title><![CDATA[Werkstudent Reporting]]></title><description><![CDATA[]]></description><pubDate>Thu, 19 Nov 2026 2:00:00 GMT</pubDate><link>https://jobs.acme.de/job/Werkstudent-Reporting/995106402/</link></item>
</channel></rss>`;

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

  it("asks Workday for the first five words, two pages each at most, and keeps a job in several places", async () => {
    stubFetch();
    const api = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/jobs";
    let next = 0;
    answers.set(api, () => {
      const page = Array.from({ length: 20 }, (_, index) => ({ title: "Reporting Analyst", externalPath: `/job/x_R${next + index}`, locationsText: "2 Locations" }));
      next += 20;
      return new Response(JSON.stringify({ total: 500, jobPostings: page }));
    });
    const jobs = await readBoard(boardFor("https://acme.wd3.myworkdayjobs.com/Careers")!, "Acme", ["a", "b", "c", "d", "e", "f", "g"]);
    const words = asked.map(({ init }) => JSON.parse(init!.body as string).searchText);
    expect(words).toEqual(["a", "a", "b", "b", "c", "c", "d", "d", "e", "e"]);
    expect(jobs[0].place).toBe("");
  });

  it("tries a 'too many requests' once more, then keeps what the words before it found", async () => {
    stubFetch();
    const api = "https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/Careers/jobs";
    answers.set(api, () => new Response("", { status: 429 }));
    await expect(readBoard(boardFor("https://acme.wd3.myworkdayjobs.com/Careers")!, "Acme", ["EMIR"])).rejects.toThrow("acme.wd3.myworkdayjobs.com asks for fewer requests just now. Dossier reads it again at the next check.");
    expect(asked).toHaveLength(2);

    asked.length = 0;
    let calls = 0;
    answers.set(api, () =>
      ++calls === 1 ? new Response(JSON.stringify({ total: 1, jobPostings: [{ title: "EMIR Analyst", externalPath: "/job/Hamburg/EMIR-Analyst_R100", locationsText: "Hamburg" }] })) : new Response("", { status: 429 }),
    );
    const failed = await readBoard(boardFor("https://acme.wd3.myworkdayjobs.com/Careers")!, "Acme", ["EMIR", "MiFIR"]).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CareersError);
    expect((failed as CareersError).partial.map((job) => job.title)).toEqual(["EMIR Analyst"]);
  });

  it("searches a SuccessFactors job feed for each word, its place from the title", async () => {
    stubFetch();
    serve("https://jobs.acme.de/services/rss/job/?locale=de_DE&keywords=Reporting", SUCCESSFACTORS);
    serve("https://jobs.acme.de/services/rss/job/?locale=de_DE&keywords=Meldewesen", SUCCESSFACTORS);
    const jobs = await readBoard(boardFor("https://jobs.acme.de/services/rss/job/?locale=de_DE")!, "Acme", ["Reporting", "Meldewesen"]);
    expect(asked).toHaveLength(2);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: "successfactors:jobs.acme.de:995106401",
      title: "Regulatory Reporting Analyst (w/m/d)",
      company: "Acme",
      place: "Frankfurt, DE",
      postedAt: "2026-11-20T02:00:00.000Z",
      url: "https://jobs.acme.de/job/Frankfurt-Regulatory-Reporting-Analyst-60549/995106401/",
      via: "SuccessFactors",
      description: "Meldewesen & COREP.",
      complete: false,
    });
    expect(jobs[1]).toMatchObject({ title: "Werkstudent Reporting", place: "" });
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
