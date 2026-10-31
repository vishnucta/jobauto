import { describe, expect, it } from "vitest";

import { APPLY_ENTRY_TEXTS, looksLikeCaptcha, looksSubmitted, SUBMIT_TEXTS } from "./confirmation";

describe("reading the employer's page", () => {
  it.each([
    "Vielen Dank für Ihre Bewerbung! Wir melden uns.",
    "Ihre Bewerbung wurde erfolgreich übermittelt.",
    "Deine Bewerbung ist bei uns eingegangen.",
    "Thank you for applying to Acme.",
    "Your application has been submitted.",
    "We have received your application and will be in touch.",
  ])("knows %s means it went through", (text) => {
    expect(looksSubmitted({ text, url: "https://acme.example/jobs/1", formGone: false })).toBe(true);
  });

  it("doesn't take the form's own words for a confirmation", () => {
    expect(looksSubmitted({ text: "Bewerbung absenden · Datenschutz · Vielen Dank für Ihr Interesse", url: "https://acme.example/apply", formGone: false })).toBe(false);
    expect(looksSubmitted({ text: "Please submit your application below.", url: "https://acme.example/apply", formGone: false })).toBe(false);
  });

  it("trusts a thank-you address only once the form has gone", () => {
    expect(looksSubmitted({ text: "Acme", url: "https://acme.example/apply/danke", formGone: false })).toBe(false);
    expect(looksSubmitted({ text: "Acme", url: "https://acme.example/apply/danke", formGone: true })).toBe(true);
    expect(looksSubmitted({ text: "Acme", url: "https://acme.example/jobs", formGone: true })).toBe(false);
  });

  it("spots a CAPTCHA in the page or its frames", () => {
    expect(looksLikeCaptcha({ html: "<div class='g-recaptcha'></div>", frameUrls: [] })).toBe(true);
    expect(looksLikeCaptcha({ html: "<form></form>", frameUrls: ["https://www.google.com/recaptcha/api2/anchor"] })).toBe(true);
    expect(looksLikeCaptcha({ html: "<form></form>", frameUrls: ["https://acme.example/widget"] })).toBe(false);
  });

  it("tells apply buttons from submit buttons", () => {
    const matches = (patterns: readonly RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));
    expect(matches(APPLY_ENTRY_TEXTS, "Jetzt online bewerben")).toBe(true);
    expect(matches(APPLY_ENTRY_TEXTS, "Apply now")).toBe(true);
    expect(matches(APPLY_ENTRY_TEXTS, "Weiter")).toBe(false);
    expect(matches(SUBMIT_TEXTS, "Bewerbung absenden")).toBe(true);
    expect(matches(SUBMIT_TEXTS, "Submit application")).toBe(true);
    expect(matches(SUBMIT_TEXTS, "Weiter")).toBe(false);
    expect(matches(SUBMIT_TEXTS, "Next")).toBe(false);
  });
});
