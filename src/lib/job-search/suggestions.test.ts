import { describe, expect, it } from "vitest";

import type { ProfileData } from "@/lib/profile";

import { MAX_WORDS, searchChips, searchWords } from "./suggestions";

const TODAY = new Date("2026-11-03T09:00:00.000Z");

type Fixture = Pick<ProfileData, "basics" | "skills" | "experience">;

const SKILLS = [
  "Regulatory Transaction Reporting", "EMIR Refit", "MiFIR", "ASIC Reporting", "COREP / IFR", "Client Asset Reconciliation", "Bank & Ledger Reconciliation",
  "Accounts Payable", "Audit Support", "VAT / Intrastat", "Taxation", "Credit Analysis", "Data Analysis", "SAP S/4HANA", "Oracle", "NetSuite", "Essbase",
  "Salesforce", "Financial modeling", "MS Excel", "Accounting", "Stakeholder Management", "Business Partnering", "Cost controlling",
];
const skills = SKILLS.map((name, index) => ({ id: `s${index}`, name }));
const ids = (...names: string[]) => names.map((name) => skills.find((skill) => skill.name === name)!.id);

const entry = (role: string, start: [number, number], end: [number, number] | null, skillNames: string[]): Fixture["experience"][number] => ({
  id: role,
  role,
  company: "Somewhere",
  location: "",
  bullets: "",
  skillIds: ids(...skillNames),
  startYear: start[0],
  startMonth: start[1],
  endYear: end?.[0] ?? null,
  endMonth: end?.[1] ?? null,
  current: end === null,
});

const basics = (patch: Partial<Fixture["basics"]> = {}) =>
  ({
    name: "Prearna Janardhanan",
    headline: "Financial Analyst — Regulatory Reporting (EMIR Refit, MiFIR, COREP) & Reconciliation",
    city: "Hamburg",
    country: "Germany",
    ...patch,
  }) as Fixture["basics"];

/** Her profile, as it is. */
const prearna: Fixture = {
  basics: basics(),
  skills,
  experience: [
    entry("Financial Analyst", [2022, 10], [2026, 4], ["Regulatory Transaction Reporting", "EMIR Refit", "MiFIR", "ASIC Reporting", "COREP / IFR", "Client Asset Reconciliation", "Accounts Payable", "Audit Support", "NetSuite"]),
    entry("Tax Data Analyst", [2019, 7], [2022, 5], ["Bank & Ledger Reconciliation", "VAT / Intrastat", "Taxation", "Data Analysis", "SAP S/4HANA", "Oracle", "Essbase"]),
    entry("Credit Analyst", [2015, 5], [2019, 2], ["Credit Analysis", "Data Analysis"]),
    entry("Article Assistant", [2014, 1], [2015, 1], ["Audit Support", "Taxation"]),
  ],
};

const texts = (result: ReturnType<typeof searchWords>, title: string, language?: "en" | "de") =>
  result.groups.find((group) => group.title === title)?.words.filter((word) => !language || word.language === language).map((word) => word.text);

describe("search words from the profile", () => {
  it("suggests, for her profile, her titles, what her headline names and the skills she used most, with the German for Hamburg", () => {
    const result = searchWords(prearna, TODAY);
    expect(result.german).toBe(true);
    expect(result.seniorYears).toBe(11);
    expect(texts(result, "Job titles")).toEqual([
      "Financial Analyst",
      "Senior Financial Analyst",
      "Regulatory Reporting Analyst",
      "Reconciliation Analyst",
      "Tax Data Analyst",
      "Credit Analyst",
      "Finanzanalyst",
      "Senior Finanzanalyst",
      "Analyst Meldewesen",
      "Kreditanalyst",
    ]);
    expect(texts(result, "Specialties")).toEqual(["Regulatory Reporting", "EMIR Refit", "EMIR", "MiFIR", "COREP", "Reconciliation", "Meldewesen", "Kontenabstimmung"]);
    // Used in two roles each, then those used in one, in the order of her list; EMIR Refit, MiFIR and COREP are named already.
    expect(texts(result, "From your skills")).toEqual(["Audit Support", "Taxation", "Data Analysis", "Regulatory Transaction Reporting", "ASIC Reporting", "IFR", "Steuerwesen", "Datenanalyse", "Transaktionsmeldung"]);
  });

  it("says where each word comes from", () => {
    const words = searchWords(prearna, TODAY).groups.flatMap((group) => group.words);
    const why = (text: string) => words.find((word) => word.text === text)?.why;
    expect(why("Financial Analyst")).toBe("Your latest role");
    expect(why("Senior Financial Analyst")).toBe("11 years of experience");
    expect(why("Regulatory Reporting Analyst")).toBe("Your headline and your role");
    expect(why("Credit Analyst")).toBe("A past role");
    expect(why("MiFIR")).toBe("Your headline");
    expect(why("Taxation")).toBe("Used in 2 roles");
    expect(why("Finanzanalyst")).toBe("German for Financial Analyst");
    expect(why("Senior Finanzanalyst")).toBe("German for Senior Financial Analyst");
  });

  it("never suggests more than three words, nor a whole headline, nor an entry-level role", () => {
    const everything = searchWords(prearna, TODAY).groups.flatMap((group) => group.words.map((word) => word.text));
    for (const text of everything) expect(text.split(/\s+/).length, text).toBeLessThanOrEqual(MAX_WORDS);
    expect(everything).not.toContain("Article Assistant");
    expect(everything.some((text) => text.includes("—") || text.includes("("))).toBe(false);
    // Too long to be a search ("Bank & Ledger Reconciliation" is three words, "Client Asset Reconciliation" too, but neither ranks).
    expect(everything).not.toContain("Salesforce Stakeholder Management Business");
  });

  it("splits a skill written with a slash, and leaves out one that is too long", () => {
    const result = searchWords(
      { basics: basics({ headline: "" }), skills: [{ id: "a", name: "COREP / IFR" }, { id: "b", name: "Preparation of supervisory reports for banks" }], experience: [] },
      TODAY,
    );
    expect(texts(result, "From your skills")).toEqual(["COREP", "IFR"]);
  });

  it("adds Senior only with years behind it, and not to a title that has a level", () => {
    const young: Fixture = { ...prearna, experience: [entry("Financial Analyst", [2023, 1], null, [])] };
    expect(texts(searchWords(young, TODAY), "Job titles")).not.toContain("Senior Financial Analyst");
    expect(searchWords(young, TODAY).seniorYears).toBeNull();
    const lead: Fixture = { ...prearna, basics: basics({ headline: "" }), experience: [entry("Lead Developer", [2010, 1], null, [])] };
    expect(texts(searchWords(lead, TODAY), "Job titles")).toEqual(["Lead Developer"]);
    expect(searchWords(lead, TODAY).seniorYears).toBeNull();
  });

  it("leaves Senior out when asked to, and says it still could be offered", () => {
    const result = searchWords(prearna, TODAY, { senior: false });
    expect(texts(result, "Job titles")).not.toContain("Senior Financial Analyst");
    expect(result.seniorYears).toBe(11);
  });

  it("offers German words only to a profile in Germany, Austria or Switzerland", () => {
    for (const country of ["Austria", "Deutschland", "Switzerland"]) expect(searchWords({ ...prearna, basics: basics({ country }) }, TODAY).german, country).toBe(true);
    const abroad = searchWords({ ...prearna, basics: basics({ country: "United Kingdom" }) }, TODAY);
    expect(abroad.german).toBe(false);
    expect(abroad.groups.flatMap((group) => group.words).every((word) => word.language === "en")).toBe(true);
    expect(texts(abroad, "Job titles")).toContain("Financial Analyst");
  });

  it("gives no German for a word the glossary doesn't have, and none that reads the same", () => {
    const result = searchWords({ basics: basics({ headline: "Designer — Brand Strategy" }), skills: [], experience: [entry("Brand Designer", [2012, 1], null, [])] }, TODAY);
    expect(texts(result, "Job titles", "de")).toEqual([]);
    expect(texts(result, "Specialties")).toEqual(["Brand Strategy"]);
  });

  it("keeps Senior and Junior in the German title, and gives none when the rest has no German", () => {
    const roles = [entry("Junior Accountant", [2012, 1], [2016, 1], []), entry("Senior Brand Designer", [2016, 2], null, [])];
    const result = searchWords({ basics: basics({ headline: "" }), skills: [], experience: roles }, TODAY);
    expect(texts(result, "Job titles", "de")).toEqual(["Junior Buchhalter"]);
  });

  it("follows the profile: a new skill or role changes the words", () => {
    const before = searchWords(prearna, TODAY);
    // Used in three roles, so it is among the skills she used most.
    const added = searchWords({ ...prearna, skills: [...skills, { id: "new", name: "Treasury" }], experience: prearna.experience.map((role, index) => (index < 3 ? { ...role, skillIds: [...role.skillIds, "new"] } : role)) }, TODAY);
    expect(texts(before, "From your skills")).not.toContain("Treasury");
    expect(texts(added, "From your skills")).toContain("Treasury");
    expect(texts(searchWords({ ...prearna, experience: [entry("Controller", [2026, 5], null, []), ...prearna.experience] }, TODAY), "Job titles")?.[0]).toBe("Controller");
  });

  it("has nothing to say about an empty profile", () => {
    expect(searchWords({ basics: basics({ headline: "", country: "" }), skills: [], experience: [] }, TODAY)).toEqual({ groups: [], german: false, seniorYears: null });
  });
});

describe("the words for Find jobs' own row", () => {
  it("are the best titles and specialties, and the German for each, six at most", () => {
    expect(searchChips(searchWords(prearna, TODAY))).toEqual(["Financial Analyst", "Senior Financial Analyst", "Regulatory Reporting", "EMIR Refit", "Meldewesen", "Finanzanalyst"]);
    expect(searchChips(searchWords(prearna, TODAY), 3)).toEqual(["Financial Analyst", "Senior Financial Analyst", "Regulatory Reporting"]);
  });

  it("stay English for a profile elsewhere, filling up from the skills", () => {
    const chips = searchChips(searchWords({ ...prearna, basics: basics({ country: "Ireland" }) }, TODAY));
    expect(chips).toEqual(["Financial Analyst", "Senior Financial Analyst", "Regulatory Reporting", "EMIR Refit", "Audit Support", "Taxation"]);
  });
});
