import { describe, expect, it } from "vitest";

import { kurzprofil } from "./kurzprofil";
import { briefLine } from "./recruiters/types";

type Input = Parameters<typeof kurzprofil>[0];

const profile = {
  basics: { name: "Erika Mustermann", headline: "Financial Analyst, regulatory reporting", email: "erika@example.com", phone: "+49 40 1234567", city: "Pinneberg", country: "Germany" },
  skills: [{ id: "s1", name: "EMIR", group: "" }, { id: "s2", name: "MiFIR", group: "" }, { id: "s3", name: "SAP S/4HANA", group: "" }],
  languages: [
    { id: "l1", name: "English", level: "C2" },
    { id: "l2", name: "German", level: "A2" },
  ],
  experience: [
    { id: "x1", role: "Financial Analyst", company: "Broker Ltd", location: "Dublin", volunteering: false, current: false, startYear: 2022, startMonth: 1, endYear: 2026, endMonth: 6, bullets: "", descriptor: "", skillIds: [] },
    { id: "x2", role: "Volunteer treasurer", company: "Club", location: "", volunteering: true, current: false, startYear: 2020, startMonth: 1, endYear: 2021, endMonth: 1, bullets: "", descriptor: "", skillIds: [] },
    { id: "x3", role: "Analyst", company: "Big Four", location: "Bangalore", volunteering: false, current: false, startYear: 2014, startMonth: 1, endYear: 2021, endMonth: 12, bullets: "", descriptor: "", skillIds: [] },
  ],
  education: [{ id: "e1", degree: "B.Com (Hons)", school: "University of Kerala", notes: "", current: false, startYear: 2008, startMonth: null, endYear: 2011, endMonth: null }],
} as unknown as Input;

const answers = { salary: "62.000 € brutto/Jahr", startDate: "2027-03-01", noticePeriod: "keine", workPermit: true, germanCourse: "B1-Kurs, Prüfung März 2027", degreeRecognition: "", mobility: "Ganz Deutschland, auch remote" };

describe("kurzprofil", () => {
  it("puts the key facts first, in German, from the profile and the standard answers", () => {
    const sheet = kurzprofil(profile, answers, new Date("2026-11-20T10:00:00Z"));
    expect(sheet).toMatchObject({ name: "Erika Mustermann", contact: ["erika@example.com", "+49 40 1234567", "Pinneberg, Germany"] });
    expect(Object.fromEntries(sheet.facts)).toEqual({
      Berufserfahrung: "12 Jahre",
      Schwerpunkte: "EMIR · MiFIR · SAP S/4HANA",
      Sprachen: "English (Fließend (C2)) · German (Grundkenntnisse (A2), B1-Kurs, Prüfung März 2027)",
      Verfügbarkeit: "ab 1. März 2027 · Kündigungsfrist: keine",
      Gehaltsvorstellung: "62.000 € brutto/Jahr",
      Arbeitserlaubnis: "Ja, ohne Visum oder Sponsoring",
      Wohnort: "Pinneberg, Germany",
      Einsatzort: "Ganz Deutschland, auch remote",
    });
  });

  it("lists paid roles one line each, with German dates, and leaves out what's empty", () => {
    const sheet = kurzprofil(profile, { ...answers, salary: "", mobility: "", workPermit: false }, new Date("2026-11-20T10:00:00Z"));
    expect(sheet.roles.map((role) => role.title)).toEqual(["Financial Analyst", "Analyst"]);
    expect(sheet.roles[0]).toEqual({ title: "Financial Analyst", company: "Broker Ltd, Dublin", dates: "Jan. 2022 – Juni 2026" });
    expect(sheet.education[0]).toMatchObject({ degree: "B.Com (Hons)", dates: "2008 – 2011" });
    expect(sheet.facts.map(([label]) => label)).not.toContain("Gehaltsvorstellung");
    expect(sheet.facts.map(([label]) => label)).not.toContain("Arbeitserlaubnis");
  });
});

describe("briefLine", () => {
  it("says what she's after and on what terms, for an agency", () => {
    expect(briefLine({ targets: ["Financial Analyst", "Regulatory Reporting Analyst"], mobility: "anywhere in Germany", start: "sofort", salary: "62.000 €" })).toBe(
      "I am looking for roles as Financial Analyst or Regulatory Reporting Analyst (anywhere in Germany). Available sofort; salary expectation 62.000 €.",
    );
    expect(briefLine({ targets: [], mobility: "", start: "2027-03-01", salary: "" })).toBe("Available from 2027-03-01.");
  });
});
