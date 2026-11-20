import { describe, expect, it } from "vitest";

import { readinessLines, recruiterDoubts, type EyeInput } from "./recruiter-eye";

const profile: EyeInput["profile"] = {
  basics: { city: "Pinneberg", country: "Germany" } as EyeInput["profile"]["basics"],
  languages: [
    { id: "l1", name: "English", level: "C2" },
    { id: "l2", name: "German", level: "A2" },
  ],
  education: [{ id: "e1", degree: "B.Com (Hons)", school: "University of Kerala", notes: "", startYear: 2008, startMonth: null, endYear: 2011, endMonth: null, current: false }] as EyeInput["profile"]["education"],
  experience: [{ id: "x1", role: "Financial Analyst", company: "Broker Ltd", location: "Dublin, Ireland", volunteering: false, bullets: "" }] as EyeInput["profile"]["experience"],
};
const answers = { workPermit: true, germanCourse: "", degreeRecognition: "" };
const GERMAN_AD = "Für unser Team in Hamburg suchen wir einen Analysten. Ihre Aufgaben sind das Meldewesen und die Abstimmung der Konten mit unseren Partnern. Wir bieten Ihnen eine spannende Aufgabe.";
const ENGLISH_AD = "We are looking for a Regulatory Reporting Analyst to join our team in Hamburg. You will own EMIR reporting and work with our operations team.";

describe("recruiterDoubts", () => {
  it("names each doubt a German recruiter has about her, with what would answer it", () => {
    const doubts = recruiterDoubts({ profile, answers, posting: GERMAN_AD, documents: "Erika Mustermann · Pinneberg" });
    expect(doubts.map((doubt) => [doubt.id, doubt.answered])).toEqual([
      ["permit", false],
      ["location", true],
      ["german", false],
      ["degree", false],
      ["local", false],
    ]);
    expect(doubts.find((doubt) => doubt.id === "german")!.fix).toContain("Add your German course");
    expect(doubts.find((doubt) => doubt.id === "degree")!.fix).toContain("ZAB Zeugnisbewertung");
  });

  it("sees what her documents already say", () => {
    const documents = "Pinneberg. I may work in Germany without a visa or sponsorship. Deutsch: A2, B1-Kurs läuft. ZAB: equivalent to a German Bachelor. EMIR and MiFIR rules are the same across the EU.";
    expect(recruiterDoubts({ profile, answers, posting: GERMAN_AD, documents }).every((doubt) => doubt.answered)).toBe(true);
  });

  it("leaves out doubts that don't apply: German for an English job she meets, a German degree, German experience", () => {
    const local = {
      ...profile,
      education: [{ ...profile.education[0], school: "Universität Hamburg" }],
      experience: [{ ...profile.experience[0], location: "Hamburg" }],
    };
    expect(recruiterDoubts({ profile: local, answers, posting: ENGLISH_AD, documents: "" }).map((doubt) => doubt.id)).toEqual(["permit", "location"]);
  });
});

describe("readinessLines", () => {
  it("says what settles the doubts, from her answers and profile", () => {
    expect(readinessLines(profile, { workPermit: true, germanCourse: "B1 course since Sept 2026, exam March 2027", degreeRecognition: "ZAB: equivalent to a German Bachelor" })).toEqual([
      "Allowed to work in Germany without a visa or sponsorship",
      "Lives in Pinneberg, Germany",
      "German: A2, B1 course since Sept 2026, exam March 2027",
      "Degree recognition: ZAB: equivalent to a German Bachelor",
    ]);
    expect(readinessLines(profile, { workPermit: false, germanCourse: "", degreeRecognition: "" })).toEqual(["Lives in Pinneberg, Germany", "German: A2"]);
    // The default yes, never saved, isn't claimed.
    expect(readinessLines(profile, { workPermit: true, confirmed: false, germanCourse: "", degreeRecognition: "" })).toEqual(["Lives in Pinneberg, Germany", "German: A2"]);
  });
});
