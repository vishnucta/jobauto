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
  const job = (title: string, description: string) => ({ title, description });
  const asks = "You run EMIR and MiFIR transaction reporting and the daily reconciliation.";

  it("finds the titles of jobs that ask for her skills, most frequent first, that her searches don't cover", () => {
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
      { title: "Middle Office Specialist", postings: 3 },
      { title: "Trade Support Analyst", postings: 2 },
    ]);
  });

  it("needs two of her terms in a posting, and a title seen at least twice", () => {
    const postings = [job("Operations Analyst", "Some reconciliation work."), job("Operations Analyst", "Some reconciliation work."), job("Fund Accountant", asks)];
    expect(hiddenTitles(postings, REPORTING_TERMS, [])).toEqual([]);
  });

  it("matches her terms as words: EMIR isn't in Emirates", () => {
    const postings = [job("Cabin Crew", "Fly with Emirates, reconciliation of duty-free sales."), job("Cabin Crew", "Fly with Emirates, reconciliation of duty-free sales.")];
    expect(hiddenTitles(postings, REPORTING_TERMS, [])).toEqual([]);
  });
});
