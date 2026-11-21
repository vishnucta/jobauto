import { describe, expect, it } from "vitest";

import { describeGuide, parseSalary, salaryGuide, titleWords } from "./salary-guide";

describe("parseSalary", () => {
  it("reads the ways postings state a yearly salary in euros", () => {
    expect(parseSalary("43.200 € bis 72.000 € pro Jahr")).toEqual({ min: 43_200, max: 72_000 });
    expect(parseSalary("EUR 60,000–80,000")).toEqual({ min: 60_000, max: 80_000 });
    expect(parseSalary("65k € brutto")).toEqual({ min: 65_000, max: 65_000 });
    expect(parseSalary("ab 55.000 EUR")).toEqual({ min: 55_000, max: 55_000 });
  });

  it("counts a monthly salary twelve times", () => {
    expect(parseSalary("4.500 € - 5.200 € monatlich")).toEqual({ min: 54_000, max: 62_400 });
  });

  it("leaves out hourly and daily rates, other currencies, and amounts no salary has", () => {
    expect(parseSalary("95 € pro Stunde")).toBeNull();
    expect(parseSalary("Tagessatz 650 €")).toBeNull();
    expect(parseSalary("$90,000 a year")).toBeNull();
    expect(parseSalary("Attraktives Gehalt")).toBeNull();
    expect(parseSalary("12 € Essenszuschuss")).toBeNull();
  });

  it("reads a range in k, and isn't put off by holidays, hours or weekdays", () => {
    expect(parseSalary("60-70k €")).toEqual({ min: 60_000, max: 70_000 });
    expect(parseSalary("Up to €70,000 per year, 30 days holiday")).toEqual({ min: 70_000, max: 70_000 });
    expect(parseSalary("Montag bis Freitag, 52.000 €")).toEqual({ min: 52_000, max: 52_000 });
    expect(parseSalary("58.000 € bei 40 Stunden pro Woche")).toEqual({ min: 58_000, max: 58_000 });
    expect(parseSalary("80 € / h")).toBeNull();
  });
});

describe("salaryGuide", () => {
  const job = (title: string, salary: string) => ({ title, salary });

  it("gives the middle half of what jobs like this one pay", () => {
    const postings = [
      job("Regulatory Reporting Analyst (m/w/d)", "55.000 € bis 65.000 € pro Jahr"),
      job("Senior Regulatory Reporting Specialist", "65.000 € bis 75.000 € pro Jahr"),
      job("Regulatory Reporting Manager", "75.000 € bis 85.000 € pro Jahr"),
      job("Reporting Analyst Meldewesen", "50.000 € bis 60.000 € pro Jahr"),
      job("Office Manager", "35.000 € pro Jahr"),
    ];
    const guide = salaryGuide("Regulatory Reporting Analyst", postings);
    expect(guide).toEqual({ low: 59_000, high: 73_000, median: 65_000, postings: 4, basis: "alike" });
    expect(describeGuide(guide!)).toBe("€59,000–€73,000 a year (middle €65,000), from 4 jobs like this one");
    // Settings → Standard answers names the title (jobauto fork).
    expect(describeGuide(guide!, "jobs like “Financial Analyst”")).toBe("€59,000–€73,000 a year (middle €65,000), from 4 jobs like “Financial Analyst”");
  });

  it("falls back to every job seen when too few are alike, and says nothing with too few salaries", () => {
    const postings = [job("Accountant", "50.000 € pro Jahr"), job("Controller", "60.000 € pro Jahr"), job("Buchhalter", "45.000 € pro Jahr")];
    expect(salaryGuide("EMIR Reporting Analyst", postings)).toMatchObject({ basis: "all", postings: 3 });
    expect(salaryGuide("Analyst", postings.slice(0, 2))).toBeNull();
  });

  it("compares titles by what the job is, not its seniority, gender marks or place", () => {
    expect([...titleWords("Senior Fund Accountant (m/w/d) Hamburg")]).toEqual(["fund", "accountant"]);
  });
});
