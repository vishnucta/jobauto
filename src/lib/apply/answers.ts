import { z } from "zod";

import type { Basics } from "@/lib/profile";

// What the apply assistant types into employers' forms: the profile's
// contact details, plus the few standard answers every German form asks
// and the profile doesn't hold (salary expectation, start date, notice
// period, work permit, language levels). Those are saved once in Settings
// (applyAnswers) and reused for every application.

/** Language levels as forms ask them (CEFR, plus native). */
export const LANGUAGE_LEVEL_ANSWERS = ["A1", "A2", "B1", "B2", "C1", "C2", "native"] as const;
export type LanguageLevelAnswer = (typeof LANGUAGE_LEVEL_ANSWERS)[number];

/** The standard answers, as stored (settings key applyAnswers). A missing or broken field reads as its default. */
export const applyAnswersSchema = z.object({
  /** e.g. "55.000 € brutto/Jahr"; empty leaves salary fields to the user. */
  salary: z.string().max(80).catch(""),
  /** "sofort", or a day as YYYY-MM-DD. */
  startDate: z.string().max(80).catch(""),
  /** e.g. "keine" or "3 Monate zum Monatsende". */
  noticePeriod: z.string().max(80).catch(""),
  /** Street and number, when the profile's address line doesn't split cleanly. */
  street: z.string().max(120).catch(""),
  postalCode: z.string().max(12).catch(""),
  /** Allowed to work in Germany without sponsorship. */
  workPermit: z.boolean().catch(true),
  germanLevel: z.enum(LANGUAGE_LEVEL_ANSWERS).catch("A2"),
  englishLevel: z.enum(LANGUAGE_LEVEL_ANSWERS).catch("C1"),
  /** Press Send for the user, on systems where that's safe; off, the user presses it herself. */
  autoSubmit: z.boolean().catch(false),
});
export type ApplyAnswers = z.output<typeof applyAnswersSchema>;
export const DEFAULT_APPLY_ANSWERS: ApplyAnswers = applyAnswersSchema.parse({});

/** Everything a form field can be filled from. */
export const ANSWER_KEYS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "street",
  "postalCode",
  "city",
  "country",
  "linkedin",
  "website",
  "dob",
  "salary",
  "startDate",
  "noticePeriod",
  "workPermit",
  "sponsorship",
  "germanLevel",
  "englishLevel",
  "message",
] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];

/** The values by key; empty when unknown. Yes/no answers are "yes" or "no". */
export type AnswerSet = Record<AnswerKey, string>;

/** What each key holds, for the report on screen and for the AI, which never sees the values. */
export const ANSWER_LABELS: Record<AnswerKey, string> = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  email: "Email address",
  phone: "Phone number",
  street: "Street and number",
  postalCode: "Postal code",
  city: "City",
  country: "Country",
  linkedin: "LinkedIn profile",
  website: "Website",
  dob: "Date of birth",
  salary: "Salary expectation",
  startDate: "Earliest start date",
  noticePeriod: "Notice period",
  workPermit: "Has a work permit (yes/no)",
  sponsorship: "Needs visa sponsorship (yes/no)",
  germanLevel: "German level",
  englishLevel: "English level",
  message: "Cover letter text / message",
};

/** "Erika Mustermann" → first "Erika", last "Mustermann"; a single word is both. */
export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/**
 * Street and postal code from a free address line such as
 * "Musterstraße 12, 20095 Hamburg": the five digits are the postal code,
 * what's before them (and the city, if it's there) is the street.
 */
export function splitAddress(address: string, city: string): { street: string; postalCode: string } {
  const line = address.trim();
  if (!line) return { street: "", postalCode: "" };
  const postal = /\b(\d{5})\b/.exec(line);
  const postalCode = postal?.[1] ?? "";
  let street = line;
  if (postal) street = line.slice(0, postal.index);
  if (city) street = street.replace(new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "");
  street = street.replace(/[\s,;]+$/, "").replace(/^[\s,;]+/, "").trim();
  return { street, postalCode };
}

/** The answers for one application, from the profile, the saved standard answers and the cover letter. */
export function buildAnswerSet({
  basics,
  answers,
  letterParagraphs,
}: {
  basics: Pick<Basics, "name" | "email" | "phone" | "address" | "city" | "country" | "linkedin" | "website" | "dob">;
  answers: ApplyAnswers;
  /** The cover letter's paragraphs, for "message" fields; empty when there's no letter. */
  letterParagraphs: string[];
}): AnswerSet {
  const { first, last } = splitName(basics.name);
  const fromAddress = splitAddress(basics.address, basics.city);
  return {
    firstName: first,
    lastName: last,
    fullName: basics.name.trim(),
    email: basics.email.trim(),
    phone: basics.phone.trim(),
    street: answers.street.trim() || fromAddress.street,
    postalCode: answers.postalCode.trim() || fromAddress.postalCode,
    city: basics.city.trim(),
    country: basics.country.trim(),
    linkedin: basics.linkedin.trim(),
    website: basics.website.trim(),
    dob: basics.dob.trim(),
    salary: answers.salary.trim(),
    startDate: answers.startDate.trim(),
    noticePeriod: answers.noticePeriod.trim(),
    workPermit: answers.workPermit ? "yes" : "no",
    sponsorship: answers.workPermit ? "no" : "yes",
    germanLevel: answers.germanLevel,
    englishLevel: answers.englishLevel,
    message: letterParagraphs.map((paragraph) => paragraph.trim()).filter(Boolean).join("\n\n"),
  };
}

/** The keys that are contact details: never sent to the AI, and shown as "filled" rather than with their value. */
export const PRIVATE_KEYS: ReadonlySet<AnswerKey> = new Set<AnswerKey>(["email", "phone", "street", "postalCode", "dob"]);
