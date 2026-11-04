import { describe, expect, it } from "vitest";

import { APPLY_ENTRY_TEXTS, entryButtons, looksBlocked, looksLikeCaptcha, looksSubmitted, SUBMIT_TEXTS } from "./confirmation";

describe("telling a bot check from the page", () => {
  it("knows the page a site answers an automated browser with", () => {
    // As read from a job aggregator behind Cloudflare.
    const german = "www.learn4good.com Sicherheitsüberprüfung wird durchgeführt Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein Bot sind. Ray ID: a55198f99bfc5fb9";
    expect(looksBlocked({ title: "Nur einen Moment…", text: german })).toBe(true);
    expect(looksBlocked({ title: "", text: german })).toBe(true);
    expect(looksBlocked({ title: "Just a moment...", text: "" })).toBe(true);
    expect(looksBlocked({ title: "Access denied", text: "You don't have permission to access this server." })).toBe(true);
    expect(looksBlocked({ title: "Attention Required! | Cloudflare", text: "Please complete the security check to access the site." })).toBe(true);
    expect(looksBlocked({ title: "", text: "Verifying that you are human. This may take a few seconds. Ray ID: 8a1" })).toBe(true);
  });

  it("doesn't take a real page for one, however it is worded", () => {
    expect(looksBlocked({ title: "Senior Analyst Aktienstrategie m/w/d | DZ BANK", text: "Das erwartet Sie. Als Senior Analyst analysieren Sie die Märkte. Jetzt bewerben" })).toBe(false);
    expect(looksBlocked({ title: "Bewerbung · Acme", text: "Vorname Nachname E-Mail Lebenslauf hochladen Absenden" })).toBe(false);
    // A long posting that mentions a security check in passing is a posting.
    const long = `${"Wir suchen Verstärkung für unser Team im Bereich Informationssicherheit. ".repeat(60)} Sie führen die Security Check Prozesse durch.`;
    expect(long.length).toBeGreaterThan(3_000);
    expect(looksBlocked({ title: "Security Engineer (m/w/d)", text: long })).toBe(false);
    expect(looksBlocked({ title: "", text: "" })).toBe(false);
  });
});

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

  it("clicks nothing on the way to the form that might send something", () => {
    const clicks = (name: string, where: { board: boolean; pastPosting: boolean }) => {
      const { texts, except } = entryButtons(where);
      return texts.some((pattern) => pattern.test(name)) && !except.some((pattern) => pattern.test(name));
    };
    const posting = { board: false, pastPosting: false };
    const board = { board: true, pastPosting: false };
    const later = { board: false, pastPosting: true };
    // The posting's own way in, and SmartRecruiters' "I'm interested", which opens its form.
    expect(clicks("Jetzt bewerben", posting)).toBe(true);
    expect(clicks("I'm interested", posting)).toBe(true);
    // On a job board, "I'm interested" shares the profile with the recruiter.
    expect(clicks("Jetzt bewerben", board)).toBe(true);
    expect(clicks("Ich bin interessiert", board)).toBe(false);
    expect(clicks("I'm interested", { board: true, pastPosting: true })).toBe(false);
    // Past the posting's own page, a button named like Send may be Send.
    expect(clicks("Jetzt bewerben", later)).toBe(false);
    expect(clicks("Bewerben", later)).toBe(false);
    expect(clicks("Apply", later)).toBe(false);
    expect(clicks("Jetzt online bewerben", later)).toBe(true);
    expect(clicks("Zur Bewerbung", later)).toBe(true);
    expect(clicks("Apply for this job", later)).toBe(true);
  });
});
