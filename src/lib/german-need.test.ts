import { describe, expect, it } from "vitest";

import { adLanguage, germanFit, germanNeed, germanVerdict, postingWriteLanguage, profileGerman } from "./german-need";

const GERMAN_AD = `Für unser Team in Hamburg suchen wir zum nächstmöglichen Zeitpunkt einen Financial Analyst (m/w/d).
Ihre Aufgaben: Sie sind verantwortlich für das regulatorische Meldewesen und die Abstimmung der Konten mit unseren Partnern.
Ihr Profil: Erfahrung im Meldewesen, sicherer Umgang mit SAP und Excel, Teamgeist und eine strukturierte Arbeitsweise.`;

const ENGLISH_AD = `We are looking for a Regulatory Reporting Analyst to join our team in Hamburg.
You will own EMIR and MiFIR transaction reporting and work with our operations and compliance teams.
Your experience: 5+ years in transaction reporting, strong Excel skills and a structured way of working.`;

describe("adLanguage", () => {
  it("tells a German ad from an English one", () => {
    expect(adLanguage(GERMAN_AD)).toBe("German");
    expect(adLanguage(ENGLISH_AD)).toBe("English");
  });

  it("says nothing about a text too short to tell", () => {
    expect(adLanguage("Financial Analyst (m/w/d)")).toBeNull();
  });
});

describe("germanNeed", () => {
  it("reads the level a sentence about German names", () => {
    expect(germanNeed("Verhandlungssichere Deutsch- und Englischkenntnisse").level).toBe("C1");
    expect(germanNeed("Gute Deutschkenntnisse in Wort und Schrift").level).toBe("B2");
    expect(germanNeed("Deutschkenntnisse erforderlich").level).toBe("B1");
    expect(germanNeed("Deutsch-Grundkenntnisse").level).toBe("A2");
    expect(germanNeed("Deutsch als Muttersprache").level).toBe("C2");
    expect(germanNeed("Fluent German and English are required").level).toBe("C1");
    expect(germanNeed("German language skills at B2 level").level).toBe("B2");
  });

  it("keeps the highest level when several sentences name one", () => {
    const need = germanNeed("Basic German is fine at first.\nBusiness fluent German within a year.");
    expect(need.level).toBe("C1");
    expect(need.evidence).toBe("Business fluent German within a year.");
  });

  it("reads German named as a plus as optional, apart from English asked for fluently", () => {
    const need = germanNeed("Fließend Englisch, Deutschkenntnisse von Vorteil");
    expect(need).toMatchObject({ level: null, optional: true, evidence: "Deutschkenntnisse von Vorteil" });
    expect(germanNeed("German is a plus but not required").optional).toBe(true);
  });

  it("doesn't take Germany, a company or German law for the language", () => {
    for (const text of ["Excellent knowledge of German GAAP", "Sehr gute Kenntnisse in Deutschland", "Fluent English for Deutsche Bank", "Good knowledge of German tax law"]) {
      expect(germanNeed(text).level).toBeNull();
    }
  });

  it("takes an ad written in German with no level as needing about B2", () => {
    expect(germanNeed(GERMAN_AD)).toMatchObject({ adLanguage: "German", level: "B2", implied: true });
    expect(germanNeed(ENGLISH_AD)).toMatchObject({ adLanguage: "English", level: null, implied: false });
  });

  it("knows a team that works in English", () => {
    const need = germanNeed(`${GERMAN_AD}\nUnsere Arbeitssprache ist Englisch.`);
    expect(need).toMatchObject({ englishWorkplace: true, implied: false, level: null, evidence: "Arbeitssprache ist Englisch" });
    expect(germanNeed("English is our working language.").englishWorkplace).toBe(true);
  });
});

describe("germanVerdict", () => {
  const need = (text: string) => germanNeed(text);

  it("fits when the profile's German is enough", () => {
    expect(germanVerdict(need("Deutschkenntnisse erforderlich"), "B1")).toBe("fits");
    expect(germanVerdict(need(ENGLISH_AD), "NONE")).toBe("fits");
    expect(germanVerdict(need("Gute Deutschkenntnisse"), "NATIVE")).toBe("fits");
  });

  it("is a stretch one level short, or when the level is only implied", () => {
    expect(germanVerdict(need("Deutschkenntnisse erforderlich"), "A2")).toBe("stretch");
    expect(germanVerdict(need(GERMAN_AD), "A2")).toBe("stretch");
  });

  it("is out two or more levels short, unless the team works in English", () => {
    expect(germanVerdict(need("Verhandlungssichere Deutschkenntnisse"), "A2")).toBe("out");
    expect(germanVerdict(need("Gute Deutschkenntnisse"), "A2")).toBe("out");
    expect(germanVerdict(need("Gute Deutschkenntnisse. Our working language is English."), "A2")).toBe("fits");
    expect(germanVerdict(need(GERMAN_AD), "NONE")).toBe("out");
  });
});

describe("profileGerman", () => {
  it("finds German by either name", () => {
    expect(profileGerman([{ name: "English", level: "C2" }, { name: "Deutsch", level: "A2" }])).toBe("A2");
    expect(profileGerman([{ name: "German (learning)", level: "B1" }])).toBe("B1");
    expect(profileGerman([{ name: "English", level: "NATIVE" }])).toBe("NONE");
  });
});

describe("germanFit", () => {
  it("labels what's worth a badge", () => {
    expect(germanFit("Verhandlungssichere Deutschkenntnisse", "A2")).toMatchObject({ verdict: "out", label: "German C1" });
    expect(germanFit(GERMAN_AD, "A2")).toMatchObject({ verdict: "stretch", label: "Ad in German" });
    expect(germanFit(ENGLISH_AD, "A2")).toMatchObject({ verdict: "fits", label: "In English" });
    expect(germanFit("Our working language is English.", "A2").label).toBe("English team");
  });
});

describe("postingWriteLanguage", () => {
  const german = "Wir suchen eine Analystin für unser Team in Hamburg. Ihre Aufgaben sind die Meldungen nach EMIR und MiFIR, die Abstimmung der Daten und die Arbeit mit unseren Kollegen.";
  it("keeps German for a German ad whose German she has", () => {
    expect(postingWriteLanguage("German", `${german} Deutschkenntnisse (A2) sind erforderlich.`, "B1")).toBe("German");
  });

  it("writes English when the ad asks for more German than she has, works in English, or names German as a plus", () => {
    expect(postingWriteLanguage("German", `${german} Verhandlungssichere Deutschkenntnisse sind erforderlich.`, "A2")).toBe("English");
    expect(postingWriteLanguage("German", german, "A2")).toBe("English");
    expect(postingWriteLanguage("German", `${german} Unsere Arbeitssprache ist Englisch.`, "C2")).toBe("English");
    expect(postingWriteLanguage("German", `${german} Deutsch von Vorteil.`, "C2")).toBe("English");
  });

  it("leaves other languages as they are", () => {
    expect(postingWriteLanguage("English", "We are hiring.", "A2")).toBe("English");
    expect(postingWriteLanguage("Dutch", "Wij zoeken", "NONE")).toBe("Dutch");
    expect(postingWriteLanguage(null, "", "A2")).toBeNull();
  });
});
