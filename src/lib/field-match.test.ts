import { describe, expect, it } from "vitest";

import { DEFAULT_FILTERS, libraryFromParams, libraryHref } from "@/lib/job-search/search";

import { checkStillOpen, FIELD_WARNING, fieldLabel, fieldMatch, fieldReason, fieldWeekLine, fieldWordsIn, lowFit } from "./field-match";

// In your field (jobauto fork, "Niche first"): the word match, its label and
// its warnings. Made-up employers and titles only.

const posting = (title: string, description = "") => ({ title, description });

describe("fieldWordsIn", () => {
  it("finds the field's words as whole words, in any case, across punctuation", () => {
    expect(fieldWordsIn("Senior Analyst EMIR-Refit & MiFIR (m/w/d)")).toEqual(["EMIR", "MiFIR"]);
    expect(fieldWordsIn("Spezialist Regulatory Reporting / Meldewesen")).toEqual(["regulatory reporting", "Meldewesen"]);
    expect(fieldWordsIn("CLIENT MONEY reconciliation")).toEqual(["reconciliation", "client money"]);
  });

  it("doesn't find a word inside another, or its parts apart", () => {
    expect(fieldWordsIn("Flight attendant, Emirates")).toEqual([]);
    expect(fieldWordsIn("Reporting to the regulatory team")).toEqual([]);
    expect(fieldWordsIn("Reconciliations Analyst")).toEqual([]);
  });
});

describe("fieldMatch", () => {
  it("marks a posting with a field word in its title, whatever its text says", () => {
    expect(fieldMatch(posting("Transaction Reporting Analyst (m/w/d)"))).toEqual({ by: "title", words: ["transaction reporting"] });
    expect(fieldMatch(posting("Spezialist Meldewesen", "Wir suchen Verstärkung."))).toEqual({ by: "title", words: ["Meldewesen"] });
    expect(fieldMatch(posting("Referent Abstimmung und COREP"))).toEqual({ by: "title", words: ["COREP", "Abstimmung"] });
  });

  it("needs two different field words when only the text names the field", () => {
    expect(fieldMatch(posting("Financial Analyst", "You prepare EMIR and MiFIR reports for the desk."))).toEqual({ by: "text", words: ["EMIR", "MiFIR"] });
    expect(fieldMatch(posting("Operations Specialist", "Daily reconciliation of client money accounts."))).toEqual({ by: "text", words: ["reconciliation", "client money"] });
  });

  it("leaves out a passing mention: one word in the text, however often", () => {
    expect(fieldMatch(posting("Financial Analyst", "Month-end reconciliation, reconciliation of ledgers and more reconciliation."))).toBeNull();
    expect(fieldMatch(posting("Accountant", "Experience with EMIR is a plus."))).toBeNull();
    expect(fieldMatch(posting("Cabin Crew", "Fly with Emirates. Reporting to the purser."))).toBeNull();
    expect(fieldMatch(posting("", ""))).toBeNull();
  });
});

describe("lowFit and fieldLabel", () => {
  const coverage = (hit: number, total: number) => ({ hit, total, mustMissing: 0 });

  it("calls it a word match until it's scored with requirements to count", () => {
    expect(fieldLabel(coverage(0, 0))).toBe("In your field (word match)");
    expect(lowFit(coverage(0, 0))).toBe(false);
  });

  it("drops the word match once it's scored, and says low fit when under half is covered", () => {
    expect(fieldLabel(coverage(3, 6))).toBe("In your field");
    expect(fieldLabel(coverage(5, 6))).toBe("In your field");
    expect(lowFit(coverage(3, 6))).toBe(false);
    expect(fieldLabel(coverage(2, 6))).toBe("In your field · low fit");
    expect(lowFit(coverage(2, 6))).toBe(true);
    expect(lowFit(coverage(0, 4))).toBe(true);
  });
});

describe("fieldReason", () => {
  it("says which words, and where", () => {
    expect(fieldReason({ by: "title", words: ["Meldewesen"] })).toBe("Meldewesen in the title");
    expect(fieldReason({ by: "text", words: ["EMIR", "MiFIR", "COREP"] })).toBe("EMIR, MiFIR and COREP in the text");
  });
});

describe("checkStillOpen", () => {
  const now = new Date("2026-11-23T10:00:00.000Z");

  it("asks to check an ad with no date, or posted more than 30 days ago", () => {
    expect(checkStillOpen(null, now)).toBe(true);
    expect(checkStillOpen("2026-10-20T00:00:00.000Z", now)).toBe(true);
    expect(checkStillOpen("not a date", now)).toBe(true);
  });

  it("doesn't for a recent one", () => {
    expect(checkStillOpen("2026-10-25T00:00:00.000Z", now)).toBe(false);
    expect(checkStillOpen(new Date("2026-11-22T00:00:00.000Z"), now)).toBe(false);
  });
});

describe("fieldWeekLine", () => {
  it("counts the week and says a word match can be wrong", () => {
    expect(fieldWeekLine({ found: 6, applied: 1 })).toBe("In your field this week: 6 found by word match, 1 applied. Word matches can be wrong, so read the posting before you apply.");
    expect(fieldWeekLine({ found: 0, applied: 0 })).toContain(FIELD_WARNING);
  });
});

describe("the Field filter in Positions' URL", () => {
  it("is ?field=1, and left out when it's off", () => {
    expect(libraryFromParams({ field: "1" }).field).toBe(true);
    expect(libraryFromParams({})).not.toHaveProperty("field");
    expect(libraryFromParams({ field: "yes" })).not.toHaveProperty("field");
    expect(libraryHref({ field: true })).toBe("/jobs?field=1");
    expect(libraryHref({ ...DEFAULT_FILTERS, field: true, sort: "new" })).toBe("/jobs?sort=new&field=1");
    expect(libraryHref({ ...DEFAULT_FILTERS, field: false })).toBe("/jobs");
  });
});
