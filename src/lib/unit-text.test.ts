import { describe, expect, it } from "vitest";

import { bulletLines, cleanUnitText, isBulletUnit, isVerbatimUnit, plainText, unitName } from "./unit-text";

describe("plainText", () => {
  it("takes out the characters that print as nothing but split a word for a parser", () => {
    expect(plainText("Pro​duct de⁠sign﻿er, front­end")).toBe("Product designer, frontend");
  });

  it("turns the non-breaking and the Unicode hyphen into a plain one", () => {
    expect(plainText("front‑end and back‐end")).toBe("front-end and back-end");
  });

  it("spells ligature glyphs out as letters", () => {
    expect(plainText("ﬁrst ﬂow oﬀ eﬃcient waﬄe")).toBe("first flow off efficient waffle");
  });

  it("keeps dashes, non-breaking spaces and the joiners other scripts need", () => {
    for (const text of ["2015–2018", "Jan 2015 – Dec 2018", "Design — then build", "4 000 users", "نرم‌افزار", "👨‍💻"]) {
      expect(plainText(text)).toBe(text);
    }
  });
});

describe("unit text", () => {
  it("keeps bullets one per line, without bullet characters or empty lines", () => {
    expect(bulletLines("- Led the portal\n\n• Built the system\n2) Ran research\n* Mentored")).toBe(
      "Led the portal\nBuilt the system\nRan research\nMentored",
    );
  });

  it("leaves a hyphen that isn't a bullet alone", () => {
    expect(bulletLines("Front-end work\n-40% support tickets")).toBe("Front-end work\n-40% support tickets");
  });

  it("reads a non-breaking hyphen as a bullet and drops a line of invisible characters", () => {
    expect(bulletLines("‑ Led the team\n​\n‐ Shipped it")).toBe("Led the team\nShipped it");
    expect(cleanUnitText("experience:e1", "‑ Led the team")).toBe("Led the team");
    expect(cleanUnitText("summary", "​\n﻿De­signer of calm tools.​")).toBe("Designer of calm tools.");
  });

  it("leaves a bullet's bold marks alone (#368)", () => {
    expect(plainText("Scaled the system by **40%**")).toBe("Scaled the system by **40%**");
    expect(bulletLines("**Scaled** the system by **40%**\n- **Led** the team")).toBe("**Scaled** the system by **40%**\n**Led** the team");
    expect(cleanUnitText("experience:e1", "* **Cut** support tickets by 40%")).toBe("**Cut** support tickets by 40%");
  });

  it("cleans a role's text as bullets and trims anything else", () => {
    expect(isBulletUnit("experience:e1")).toBe(true);
    expect(isBulletUnit("project:p1")).toBe(true);
    expect(isBulletUnit("summary")).toBe(false);
    expect(cleanUnitText("project:p1", "• Built it\n\n• Shipped it")).toBe("Built it\nShipped it");
    expect(cleanUnitText("experience:e1", " - One \n - Two ")).toBe("One\nTwo");
    expect(cleanUnitText("paragraph:1", "  First line.\n\nSecond.  ")).toBe("First line.\n\nSecond.");
  });

  it("treats a custom section's parts as word for word, and only an entry's as bullets (#298)", () => {
    for (const id of ["custom-entry:i1", "custom-line:i1", "custom-inline:s1"]) expect(isVerbatimUnit(id)).toBe(true);
    expect(isBulletUnit("custom-entry:i1")).toBe(true);
    expect(isBulletUnit("custom-line:i1")).toBe(false);
    expect(cleanUnitText("custom-entry:i1", "- Taught")).toBe("Taught");
    expect(cleanUnitText("custom-line:i1", "- A line stays as written")).toBe("- A line stays as written");
    expect(unitName({ id: "custom-line:i1", label: "Best Paper" })).toBe("Best Paper");
  });

  it("knows the parts copied word for word: certifications and publications (#293, #218)", () => {
    expect(isVerbatimUnit("certification:c1")).toBe(true);
    expect(isVerbatimUnit("publication:u1")).toBe(true);
    expect(isVerbatimUnit("education:d1")).toBe(false);
  });
});

describe("unitName", () => {
  it("names a unit as a sentence would", () => {
    expect(unitName({ id: "summary", label: "Summary" })).toBe("summary");
    expect(unitName({ id: "sign-off", label: "Sign-off" })).toBe("sign-off");
    expect(unitName({ id: "paragraph:1", label: "Opening" })).toBe("opening paragraph");
    expect(unitName({ id: "paragraph:2", label: "Middle paragraph" })).toBe("middle paragraph");
    expect(unitName({ id: "experience:e1", label: "Northwind Logistics role" })).toBe("Northwind Logistics role");
    expect(unitName({ id: "education:d1", label: "MSc Design for Interaction" })).toBe("MSc Design for Interaction");
    expect(unitName({ id: "certification:c1", label: "Certification “Certified Accessibility Specialist”" })).toBe("Certification “Certified Accessibility Specialist”");
  });
});
