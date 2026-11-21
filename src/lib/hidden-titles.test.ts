import { describe, expect, it } from "vitest";

import { coreTitle, hiddenTitles, REPORTING_TERMS } from "./hidden-titles";

describe("coreTitle", () => {
  it("keeps what the job is, without gender marks, seniority, place or extras", () => {
    expect(coreTitle("Senior Trade Support Analyst (m/w/d) – Hamburg")).toBe("Trade Support Analyst");
    expect(coreTitle("Spezialist*in Meldewesen m/w/d")).toBe("Spezialist Meldewesen");
    expect(coreTitle("Middle Office Associate | Derivatives")).toBe("Middle Office");
    expect(coreTitle("Junior Regulatory Operations Analyst, Frankfurt")).toBe("Regulatory Operations Analyst");
  });
});

describe("hiddenTitles", () => {
  let employer = 0;
  // Each job at an employer of its own, unless it names one.
  const job = (title: string, description: string, company = `Employer ${(employer += 1)}`) => ({ title, description, company });
  const asks = "You run EMIR and MiFIR transaction reporting and the daily reconciliation.";

  it("finds the titles of jobs that ask for her skills, used by the most employers first, that her searches don't cover", () => {
    const postings = [
      job("Trade Support Analyst (m/w/d)", asks),
      job("Senior Trade Support Analyst", asks),
      job("Middle Office Specialist", asks),
      job("Middle Office Specialist - Hamburg", asks),
      job("Middle Office Specialist", asks),
      job("Regulatory Reporting Analyst", asks),
      job("Regulatory Reporting Analyst", asks),
      job("Marketing Manager", "Brand campaigns and events."),
      job("Marketing Manager", "Brand campaigns and events."),
    ];
    expect(hiddenTitles(postings, REPORTING_TERMS, ["Regulatory Reporting"])).toEqual([
      { title: "Middle Office Specialist", employers: 3 },
      { title: "Trade Support Analyst", employers: 2 },
    ]);
  });

  it("needs two of her terms in a posting, and a title used by at least two employers", () => {
    const postings = [job("Operations Analyst", "Some reconciliation work."), job("Operations Analyst", "Some reconciliation work."), job("Fund Accountant", asks)];
    expect(hiddenTitles(postings, REPORTING_TERMS, [])).toEqual([]);
  });

  it("counts each employer once: one employer's own title, posted five times, isn't one employers use (jobauto fork)", () => {
    const postings = [...Array.from({ length: 5 }, () => job("MSC Finance Analyst 5", asks, "Ledgerly AG")), job("FP&A Analyst", asks, "Ledgerly AG"), job("FP&A Analyst", asks, "Northwind GmbH")];
    expect(hiddenTitles(postings, REPORTING_TERMS, [])).toEqual([{ title: "FP&A Analyst", employers: 2 }]);
  });

  it("leaves out engineering titles, which ask for her tools but aren't her job (jobauto fork)", () => {
    const postings = [job("Financial Analytics Engineer", asks), job("Financial Analytics Engineer", asks), job("Reporting Developer (m/w/d)", asks), job("Reporting Developer", asks)];
    expect(hiddenTitles(postings, REPORTING_TERMS, [])).toEqual([]);
  });

  it("counts a past search as covering a title only word for word", () => {
    const postings = [job("Credit Risk Analyst", asks), job("Credit Risk Analyst", asks)];
    expect(hiddenTitles(postings, REPORTING_TERMS, ["IT"])).toEqual([{ title: "Credit Risk Analyst", employers: 2 }]);
    expect(hiddenTitles(postings, REPORTING_TERMS, ["Risk Analyst"])).toEqual([]);
  });

  it("matches her terms as words: EMIR isn't in Emirates", () => {
    const postings = [job("Cabin Crew", "Fly with Emirates, reconciliation of duty-free sales."), job("Cabin Crew", "Fly with Emirates, reconciliation of duty-free sales.")];
    expect(hiddenTitles(postings, REPORTING_TERMS, [])).toEqual([]);
  });
});
