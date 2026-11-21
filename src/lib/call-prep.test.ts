import { describe, expect, it } from "vitest";

import { DEFAULT_APPLY_ANSWERS } from "@/lib/apply/answers";

import { callAnswers, callPrepOf, flaggedSentences, spokenMatch, unsavedStudyLength } from "./call-prep";

describe("spokenMatch", () => {
  it("counts the written answer's words that were said, ignoring case and punctuation", () => {
    expect(spokenMatch("Ich arbeite mit SAP.", "ich arbeite mit sap")).toBe(100);
    expect(spokenMatch("Ich arbeite seit zehn Jahren im Meldewesen.", "ich arbeite im meldewesen")).toBe(57);
    expect(spokenMatch("Ja, ja, gerne.", "ja gerne")).toBe(67);
    expect(spokenMatch("", "egal")).toBe(0);
  });
});

describe("callPrepOf", () => {
  it("reads a stored pack, and nothing else", () => {
    expect(callPrepOf(null)).toBeNull();
    expect(callPrepOf({ questions: "nope" })).toBeNull();
    expect(callPrepOf({ questions: [], salary: { de: "", en: "" }, stories: [], toAsk: [], gaps: [] })).toMatchObject({ unverified: [] });
  });
});

describe("her standard answers in call prep (jobauto fork)", () => {
  it("counts a work permit she never confirmed as no answer", () => {
    expect(callAnswers({ ...DEFAULT_APPLY_ANSWERS, confirmed: false })).toMatchObject({ workPermit: null });
    expect(callAnswers({ ...DEFAULT_APPLY_ANSWERS, confirmed: true, startDate: " sofort " })).toMatchObject({ workPermit: true, startDate: "sofort", noticePeriod: "" });
  });

  it("quotes the sentence a flag is in, once", () => {
    const said = "I am a designer. I worked in Europe for 1 year.\nI like Initech.";
    expect(flaggedSentences(said, ["Europe", "1", "Initech", "Mars"])).toEqual(["I worked in Europe for 1 year.", "I like Initech.", "Mars"]);
  });
});

describe("unsavedStudyLength (jobauto fork)", () => {
  it("flags how long she's learned German when her German course doesn't say", () => {
    const said = "I use SAP. I have been learning German for a year.\nI started learning German since 2025. My German is at A2.";
    expect(unsavedStudyLength(said, { germanCourse: "" })).toEqual(["I have been learning German for a year.", "I started learning German since 2025."]);
    expect(unsavedStudyLength(said, { germanCourse: "B1 course since March 2026" })).toEqual([]);
    expect(unsavedStudyLength("I keep learning German every day.", { germanCourse: "" })).toEqual([]);
  });
});
