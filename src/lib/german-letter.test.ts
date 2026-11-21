import { describe, expect, it } from "vitest";

import { contactInPosting, germanGreeting, germanRecipient, readContact } from "./german-letter";

const posting = "Analyst (m/w/d) bei Muster Capital GmbH, Hamburg. Ihr Ansprechpartner: Herr Dr. Max Mustermann, Tel. 040 123456.";

describe("readContact (jobauto fork)", () => {
  it("reads the person the posting names, with salutation and titles", () => {
    expect(readContact("Herr Dr. Max Mustermann", posting)).toEqual({ salutation: "Herr", titles: "Dr.", name: "Max Mustermann", surname: "Mustermann" });
    expect(readContact("  Frau   Erika Mustermann ", `${posting} Frau Erika Mustermann`)).toEqual({ salutation: "Frau", titles: "", name: "Erika Mustermann", surname: "Mustermann" });
    expect(readContact("Max Mustermann", posting)).toEqual({ salutation: null, titles: "", name: "Max Mustermann", surname: "Mustermann" });
    expect(readContact("Frau Anna von Berg", "Fragen an Frau Anna von Berg")).toMatchObject({ name: "Anna von Berg", surname: "von Berg" });
    // Taken from what the posting writes around the name.
    expect(readContact("Herrn Max Mustermann (max@example.com)", posting)).toMatchObject({ salutation: "Herr", name: "Max Mustermann" });
    expect(readContact("Ihr Ansprechpartner: Herr Dr. Max Mustermann, Teamleitung", posting)).toMatchObject({ titles: "Dr.", name: "Max Mustermann" });
  });

  it("writes no one the posting doesn't name, and nothing that isn't a name", () => {
    expect(readContact("Herr John Doe", posting)).toBeNull();
    expect(readContact(null, posting)).toBeNull();
    expect(readContact("", posting)).toBeNull();
    expect(readContact("jobs@example.com", posting)).toBeNull();
    expect(readContact("Tel. 040 123456", posting)).toBeNull();
    expect(readContact("Personalabteilung Muster Capital", posting)).toBeNull();
    expect(readContact("the hiring team", posting)).toBeNull();
  });
});

describe("contactInPosting (jobauto fork)", () => {
  it("finds the person the posting names with Herr or Frau", () => {
    expect(contactInPosting("Bitte senden Sie Ihre Unterlagen an\n Herrn Max Mustermann (mm@example.com).")).toEqual({ salutation: "Herr", titles: "", name: "Max Mustermann", surname: "Mustermann" });
    expect(contactInPosting(posting)).toMatchObject({ titles: "Dr.", name: "Max Mustermann" });
    expect(contactInPosting("Fragen beantwortet Frau Erika Mustermann gern.")).toMatchObject({ salutation: "Frau", name: "Erika Mustermann" });
    expect(contactInPosting("Wir freuen uns auf Ihre Bewerbung!")).toBeNull();
  });
});

describe("a German letter's recipient and greeting (jobauto fork)", () => {
  const herr = readContact("Herr Dr. Max Mustermann", posting);
  const frau = { salutation: "Frau" as const, titles: "", name: "Erika Mustermann", surname: "Mustermann" };
  const plain = { salutation: null, titles: "", name: "Kim Mustermann", surname: "Mustermann" };

  it("addresses the named contact z. Hd., under the company and above the place", () => {
    expect(germanRecipient({ company: "Muster Capital GmbH", contact: herr, place: ["Hamburg"] })).toBe("Muster Capital GmbH\nz. Hd. Herrn Dr. Max Mustermann\nHamburg");
    expect(germanRecipient({ company: "Muster Capital GmbH", contact: frau, place: [] })).toBe("Muster Capital GmbH\nz. Hd. Frau Erika Mustermann");
    expect(germanRecipient({ company: "Muster Capital GmbH", contact: plain, place: [] })).toBe("Muster Capital GmbH\nz. Hd. Kim Mustermann");
    expect(germanRecipient({ company: "Muster Capital GmbH", contact: null, place: ["Hamburg"] })).toBe("Muster Capital GmbH\nPersonalabteilung\nHamburg");
    expect(germanRecipient({ company: "", contact: null, place: [] })).toBe("Personalabteilung");
  });

  it("greets the named contact by name, everyone else as usual", () => {
    expect(germanGreeting(herr)).toBe("Sehr geehrter Herr Dr. Mustermann,");
    expect(germanGreeting(frau)).toBe("Sehr geehrte Frau Mustermann,");
    expect(germanGreeting(plain)).toBe("Guten Tag Kim Mustermann,");
    expect(germanGreeting(null)).toBe("Sehr geehrte Damen und Herren,");
  });
});
