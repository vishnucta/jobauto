import { describe, expect, it } from "vitest";

import { availabilityLines, letterAvailability, missingWords, postingAsks } from "./letter-availability";

const answers = { salary: "58.000 € brutto/Jahr", startDate: "2027-03-01", noticePeriod: "3 Monate zum Monatsende" };

describe("postingAsks", () => {
  it("reads the German and English ways of asking", () => {
    expect(postingAsks("Bitte senden Sie uns Ihre Unterlagen inkl. Gehaltsvorstellung und frühestmöglichem Eintrittstermin.")).toEqual({ salary: true, start: true });
    expect(postingAsks("Ihre Bewerbung mit Angabe Ihrer Verfügbarkeit")).toEqual({ salary: false, start: true });
    expect(postingAsks("Please include your salary expectations and notice period.")).toEqual({ salary: true, start: true });
    expect(postingAsks("Wir freuen uns auf Ihre Bewerbung!")).toEqual({ salary: false, start: false });
  });
});

describe("letterAvailability", () => {
  it("gives the letter only what the posting asks for", () => {
    expect(letterAvailability("Gehaltsvorstellung und Eintrittstermin", answers)).toEqual({ say: { salary: "58.000 € brutto/Jahr", start: "2027-03-01", notice: "3 Monate zum Monatsende" }, missing: [] });
    expect(letterAvailability("Ihre Gehaltsvorstellung", answers)).toEqual({ say: { salary: "58.000 € brutto/Jahr" }, missing: [] });
    expect(letterAvailability("Nichts davon", answers)).toEqual({ say: null, missing: [] });
  });

  it("says what's asked for but has no answer, and counts a notice period as an answer about the start", () => {
    expect(letterAvailability("Gehaltsvorstellung und Eintrittstermin", { salary: " ", startDate: "", noticePeriod: "" })).toEqual({ say: null, missing: ["salary", "start"] });
    expect(letterAvailability("Eintrittstermin", { salary: "", startDate: "", noticePeriod: "keine" })).toEqual({ say: { notice: "keine" }, missing: [] });
  });
});

describe("availabilityLines and missingWords", () => {
  it("writes the answers for the prompt, a day as a date to write in the letter's language", () => {
    expect(availabilityLines({ salary: "58.000 €", start: "2027-03-01", notice: "keine" })).toEqual([
      "Salary expectation: 58.000 €",
      "Earliest start: 2027-03-01 (a date: write it as the letter's language writes dates)",
      "Notice period: keine",
    ]);
    expect(availabilityLines({ start: "sofort" })).toEqual(["Earliest start: sofort"]);
    expect(missingWords(["salary", "start"])).toBe("your salary expectation and your earliest start date");
  });
});
