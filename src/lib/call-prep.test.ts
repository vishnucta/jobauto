import { describe, expect, it } from "vitest";

import { callPrepOf, spokenMatch } from "./call-prep";

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
