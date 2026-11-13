import { describe, expect, it } from "vitest";

import { LanguageLevel } from "@/generated/prisma/enums";

import {
  ageOn,
  BASICS_FIELDS,
  basicsFromFields,
  byStartDateDesc,
  inEntryOrder,
  fieldsFromBasics,
  filledBasics,
  splitAddressLine,
  formatDateRange,
  formatMonthYear,
  LANGUAGE_LEVELS,
  languageLevelLabel,
  profileStrength,
  type DateSpan,
} from "./profile";

const span = (overrides: Partial<DateSpan>): DateSpan => ({
  startYear: null,
  startMonth: null,
  endYear: null,
  endMonth: null,
  current: false,
  ...overrides,
});

describe("language levels", () => {
  it("lists every level with the prototype's labels, Native first", () => {
    expect(LANGUAGE_LEVELS.map((level) => level.label)).toEqual([
      "Native",
      "Fluent (C2)",
      "Advanced (C1)",
      "Upper intermediate (B2)",
      "Intermediate (B1)",
      "Elementary (A2)",
      "Beginner (A1)",
    ]);
    expect(LANGUAGE_LEVELS).toHaveLength(Object.keys(LanguageLevel).length);
    expect(languageLevelLabel(LanguageLevel.B1)).toBe("Intermediate (B1)");
  });
});

describe("dates", () => {
  it("formats a month and year, a year, or nothing", () => {
    expect(formatMonthYear(2021, 3)).toBe("Mar 2021");
    expect(formatMonthYear(2015, 9)).toBe("Sep 2015");
    expect(formatMonthYear(2013, null)).toBe("2013");
    expect(formatMonthYear(null, 5)).toBe("");
  });

  it("formats ranges as in the prototype", () => {
    expect(formatDateRange(span({ startYear: 2021, startMonth: 3, current: true }))).toBe(
      "Mar 2021 – Present",
    );
    expect(
      formatDateRange(span({ startYear: 2015, startMonth: 9, endYear: 2018, endMonth: 5 })),
    ).toBe("Sep 2015 – May 2018");
    expect(formatDateRange(span({ startYear: 2013, endYear: 2015 }))).toBe("2013 – 2015");
    expect(formatDateRange(span({ startYear: 2013 }))).toBe("2013");
    expect(formatDateRange(span({}))).toBe("");
  });

  it("uses the current flag instead of an end date", () => {
    expect(formatDateRange(span({ startYear: 2021, endYear: 2022, current: true }))).toBe(
      "2021 – Present",
    );
  });

  it("formats month names and 'Present' in the document's language", () => {
    expect(
      formatDateRange(span({ startYear: 2021, startMonth: 3, current: true }), {
        locale: "de",
        present: "heute",
      }),
    ).toBe("März 2021 – heute");
  });

  it("writes dates in the locale's own order and digits, in the Gregorian calendar", () => {
    expect(formatDateRange(span({ startYear: 2019, startMonth: 9, endYear: 2021, endMonth: 3 }), { locale: "ja" })).toBe("2019年9月 – 2021年3月");
    expect(formatDateRange(span({ startYear: 2013, endYear: 2015 }), { locale: "zh-Hans" })).toBe("2013年 – 2015年");
    // Persian's own calendar would make September 2021 "Shahrivar 1400".
    expect(formatMonthYear(2021, 9, { locale: "fa" })).toBe("سپتامبر ۲۰۲۱");
  });

  it("orders entries newest first, then by sort, with undated ones last", () => {
    const entries = [
      { id: "fieldnote", ...span({ startYear: 2018, startMonth: 6 }), sort: 0 },
      { id: "undated", ...span({}), sort: 0 },
      { id: "northwind", ...span({ startYear: 2021, startMonth: 3, current: true }), sort: 2 },
      { id: "brik", ...span({ startYear: 2015, startMonth: 9 }), sort: 0 },
      { id: "same-year", ...span({ startYear: 2021, startMonth: 3 }), sort: 1 },
    ];
    expect(entries.sort(byStartDateDesc).map((entry) => entry.id)).toEqual([
      "same-year",
      "northwind",
      "fieldnote",
      "brik",
      "undated",
    ]);
  });
});

describe("basics", () => {
  const empty = {
    name: "", headline: "", email: "", phone: "", dob: "", website: "",
    street: "", houseNumber: "", postalCode: "", city: "", country: "", linkedin: "", summary: "",
  };

  it("counts filled required fields, ignoring whitespace", () => {
    expect(BASICS_FIELDS).toHaveLength(13);
    expect(filledBasics(empty)).toBe(0);
    expect(filledBasics({ ...empty, name: "Jane", email: "jane.doe@example.com", city: "  " })).toBe(2);
  });

  it("computes the age from the date of birth", () => {
    const today = new Date(2026, 8, 28); // 28 September 2026, local time
    expect(ageOn("1992-04-18", today)).toBe(34);
    expect(ageOn("1992-09-28", today)).toBe(34); // birthday today
    expect(ageOn("1992-09-29", today)).toBe(33); // birthday tomorrow
    expect(ageOn("", today)).toBeNull();
    expect(ageOn("2030-01-01", today)).toBeNull();
  });
});

describe("profile strength", () => {
  const basics = Object.fromEntries(BASICS_FIELDS.map((field) => [field, ""])) as Record<(typeof BASICS_FIELDS)[number], string>;
  const none = { basics, experience: 0, education: 0, skills: 0 };
  const required = { ...basics, name: "L", headline: "h", email: "e", city: "c", country: "n", summary: "s" };

  it("weighs the required basics 40, experience 30, education 15 and skills 15", () => {
    expect(profileStrength(none).percent).toBe(0);
    expect(profileStrength({ ...none, experience: 1 }).percent).toBe(30);
    expect(profileStrength({ ...none, basics: required, experience: 3, education: 2, skills: 7 }).percent).toBe(100);
    // 4 of 6 required basics = 26.7 → 27, plus skills 15
    expect(profileStrength({ ...none, basics: { ...basics, name: "L", email: "e", city: "c", summary: "s" }, skills: 1 }).percent).toBe(42);
  });

  it("leaves out the optional basics (#216)", () => {
    const optional = { ...basics, phone: "p", dob: "1992-04-18", website: "w", street: "s", houseNumber: "1", postalCode: "12345", linkedin: "l" };
    expect(profileStrength({ ...none, basics: optional }).percent).toBe(0);
    expect(filledBasics(optional)).toBe(0);
  });

  it("encourages at every level", () => {
    expect(profileStrength(none).hint).toBe("A good start. Experience matters most.");
    expect(profileStrength({ ...none, basics: required, experience: 1 }).hint).toBe(
      "Nice progress. A bit more detail makes tailoring sharper.",
    );
    expect(profileStrength({ ...none, basics: { ...required, summary: "" }, experience: 1, education: 1, skills: 1 }).percent).toBe(93);
    expect(profileStrength({ ...none, basics: { ...required, summary: "" }, experience: 1, education: 1, skills: 1 }).hint).toBe(
      "Looking great. The AI has plenty to work with.",
    );
    expect(profileStrength({ ...none, basics: required, experience: 1, education: 1, skills: 1 }).hint).toBe(
      "All set. The optional sections are there if they help.",
    );
  });
});

describe("stored basics", () => {
  const basics = {
    ...(Object.fromEntries(BASICS_FIELDS.map((field) => [field, ""])) as Record<(typeof BASICS_FIELDS)[number], string>),
    name: "Jane Doe",
    dob: "1992-04-18",
    showAge: true,
  };

  it("stores filled-in fields as text and marks empty ones for removal", () => {
    expect(fieldsFromBasics(basics)).toMatchObject({ name: "Jane Doe", dob: "1992-04-18", showAge: "true", email: null });
    expect(fieldsFromBasics({ ...basics, showAge: false }).showAge).toBeNull();
  });

  it("reads them back, with missing keys empty and unknown ones ignored", () => {
    const rows = Object.entries(fieldsFromBasics(basics)).flatMap(([key, value]) => (value === null ? [] : [{ key, value }]));
    expect(basicsFromFields(rows)).toEqual(basics);
    expect(basicsFromFields([{ key: "nickname", value: "Lee" }])).toEqual({ ...basics, name: "", dob: "", showAge: false });
  });

  it("reads the old one-line address into street, number, postal code and city, the line's city first", () => {
    const read = basicsFromFields([
      { key: "address", value: "Musterweg 7, Pinneberg 25421" },
      { key: "city", value: "Hamburg" },
    ]);
    expect(read).toMatchObject({ street: "Musterweg", houseNumber: "7", postalCode: "25421", city: "Pinneberg" });
    // Without a city in the line, the City field stays.
    expect(basicsFromFields([{ key: "address", value: "Musterweg 7" }, { key: "city", value: "Hamburg" }])).toMatchObject({ street: "Musterweg", houseNumber: "7", postalCode: "", city: "Hamburg" });
  });

  it("ignores the old line once the address is stored in parts", () => {
    const read = basicsFromFields([
      { key: "address", value: "Musterweg 7, 25421 Pinneberg" },
      { key: "street", value: "Neue Straße" },
      { key: "city", value: "Hamburg" },
    ]);
    expect(read).toMatchObject({ street: "Neue Straße", houseNumber: "", postalCode: "", city: "Hamburg" });
  });
});

describe("splitAddressLine", () => {
  it.each([
    ["Musterstraße 12, 20095 Hamburg", { street: "Musterstraße", houseNumber: "12", postalCode: "20095", city: "Hamburg" }],
    ["Musterstraße 12a 20095 Hamburg", { street: "Musterstraße", houseNumber: "12a", postalCode: "20095", city: "Hamburg" }],
    ["Am Markt 3-5, Pinneberg 25421", { street: "Am Markt", houseNumber: "3-5", postalCode: "25421", city: "Pinneberg" }],
    ["12 Main Street, Springfield", { street: "Main Street", houseNumber: "12", postalCode: "", city: "Springfield" }],
    ["Musterstraße", { street: "Musterstraße", houseNumber: "", postalCode: "", city: "" }],
    ["  ", { street: "", houseNumber: "", postalCode: "", city: "" }],
  ])("splits %j", (line, parts) => {
    expect(splitAddressLine(line)).toEqual(parts);
  });
});

describe("inEntryOrder (E4-9)", () => {
  const entry = (id: string, startYear: number | null, sort: number) => ({ id, startYear, startMonth: null, endYear: null, endMonth: null, current: false, sort });
  const entries = [entry("old", 2015, 0), entry("undated", null, 1), entry("new", 2021, 2)];

  it("orders by date, or by the order set by hand, without changing the input", () => {
    expect(inEntryOrder(entries, "date").map((e) => e.id)).toEqual(["new", "old", "undated"]);
    expect(inEntryOrder(entries, "manual").map((e) => e.id)).toEqual(["old", "undated", "new"]);
    expect(entries.map((e) => e.id)).toEqual(["old", "undated", "new"]);
  });
});

