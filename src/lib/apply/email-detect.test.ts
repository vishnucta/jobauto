import { describe, expect, it } from "vitest";

import { applyEmailIn } from "./email-detect";

describe("the address a posting says to apply to", () => {
  it("finds a plain application address", () => {
    expect(applyEmailIn("Ihre vollständigen Bewerbungsunterlagen senden Sie bitte an bewerbung@acme-gmbh.de.")).toBe("bewerbung@acme-gmbh.de");
  });

  it("prefers the application address over a contact or privacy one", () => {
    const text = [
      "Fragen beantwortet Frau Müller unter info@acme.de.",
      "Datenschutzhinweise: datenschutz@acme.de",
      "Bitte richten Sie Ihre Bewerbung per E-Mail an karriere@acme.de",
    ].join("\n");
    expect(applyEmailIn(text)).toBe("karriere@acme.de");
  });

  it("takes a named recruiter's address when the context says to apply there", () => {
    expect(applyEmailIn("Please send your CV and a short note to anna.schmidt@acme.com. We look forward to it!")).toBe("anna.schmidt@acme.com");
  });

  it("never answers a no-reply, newsletter or example address", () => {
    expect(applyEmailIn("Diese Mail wurde von noreply@jobboard.de gesendet. Newsletter: newsletter@acme.de")).toBeNull();
    expect(applyEmailIn("Contact: jane@example.com")).toBeNull();
  });

  it("drops trailing punctuation and lower-cases", () => {
    expect(applyEmailIn("Bewerbung an: Jobs@Acme.DE, bis 30.11.")).toBe("jobs@acme.de");
  });

  it("is null without an address", () => {
    expect(applyEmailIn("Bewerben Sie sich über unser Karriereportal.")).toBeNull();
    expect(applyEmailIn("")).toBeNull();
  });
});
