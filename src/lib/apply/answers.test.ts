import { describe, expect, it } from "vitest";

import { applyAnswersSchema, buildAnswerSet, DEFAULT_APPLY_ANSWERS, splitAddress, splitName } from "./answers";

const basics = {
  name: "Erika Mustermann",
  email: "p@example.com",
  phone: "+49 170 1234567",
  address: "Musterstraße 12, 20095 Hamburg",
  city: "Hamburg",
  country: "Germany",
  linkedin: "https://www.linkedin.com/in/p",
  website: "",
  dob: "1985-01-15",
};

describe("the standard answers (Phase A)", () => {
  it("read as their defaults when missing or broken", () => {
    expect(DEFAULT_APPLY_ANSWERS).toEqual({
      salary: "",
      startDate: "",
      noticePeriod: "",
      street: "",
      postalCode: "",
      workPermit: true,
      germanLevel: "A2",
      englishLevel: "C1",
      autoSubmit: false,
    });
    expect(applyAnswersSchema.parse({ germanLevel: "Z9", workPermit: "maybe", salary: 42 })).toMatchObject({ germanLevel: "A2", workPermit: true, salary: "" });
  });

  it("split a name into first and last", () => {
    expect(splitName("Erika Mustermann")).toEqual({ first: "Erika", last: "Mustermann" });
    expect(splitName("Anna Maria Schmidt")).toEqual({ first: "Anna Maria", last: "Schmidt" });
    expect(splitName("Cher")).toEqual({ first: "Cher", last: "Cher" });
    expect(splitName("  ")).toEqual({ first: "", last: "" });
  });

  it("split a German address line into street and postal code", () => {
    expect(splitAddress("Musterstraße 12, 20095 Hamburg", "Hamburg")).toEqual({ street: "Musterstraße 12", postalCode: "20095" });
    expect(splitAddress("Musterstraße 12", "Hamburg")).toEqual({ street: "Musterstraße 12", postalCode: "" });
    expect(splitAddress("", "Hamburg")).toEqual({ street: "", postalCode: "" });
  });

  it("build the set from the profile, the saved answers and the letter", () => {
    const set = buildAnswerSet({
      basics,
      answers: { ...DEFAULT_APPLY_ANSWERS, salary: "55.000 €", startDate: "sofort", workPermit: true },
      letterParagraphs: [" Sehr geehrte Damen und Herren, ", "", "ich bewerbe mich."],
    });
    expect(set).toMatchObject({
      firstName: "Erika",
      lastName: "Mustermann",
      fullName: "Erika Mustermann",
      street: "Musterstraße 12",
      postalCode: "20095",
      city: "Hamburg",
      country: "Germany",
      salary: "55.000 €",
      startDate: "sofort",
      workPermit: "yes",
      sponsorship: "no",
      germanLevel: "A2",
      englishLevel: "C1",
      message: "Sehr geehrte Damen und Herren,\n\nich bewerbe mich.",
    });
  });

  it("let the saved street and postal code win over the address line", () => {
    const set = buildAnswerSet({ basics, answers: { ...DEFAULT_APPLY_ANSWERS, street: "Neue Str. 1", postalCode: "22222", workPermit: false }, letterParagraphs: [] });
    expect(set).toMatchObject({ street: "Neue Str. 1", postalCode: "22222", workPermit: "no", sponsorship: "yes", message: "" });
  });
});
