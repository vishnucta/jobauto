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
  /**
   * Street and number, and postal code, from before the profile held the address in parts.
   * No longer shown: used only while the profile's own street and postal code are empty.
   */
  street: z.string().max(120).catch(""),
  postalCode: z.string().max(12).catch(""),
  /** Allowed to work in Germany without sponsorship. */
  workPermit: z.boolean().catch(true),
  /** The German course she's in, and the exam date, e.g. "B1 course since Sept 2026, exam March 2027" (recruiter-eye.ts). */
  germanCourse: z.string().max(120).catch(""),
  /** Her degree's German equivalence, e.g. "ZAB statement: equivalent to a German Bachelor" (recruiter-eye.ts). */
  degreeRecognition: z.string().max(160).catch(""),
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
  "houseNumber",
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
  houseNumber: "House number",
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
 * The answers for one application, from the profile, the saved standard answers and the cover letter.
 * The address is the profile's: street is the street with its number, for forms with one field for
 * both; a form with a field of its own for the number gets them apart (planFill).
 */
export function buildAnswerSet({
  basics,
  answers,
  letterParagraphs,
}: {
  basics: Pick<Basics, "name" | "email" | "phone" | "street" | "houseNumber" | "postalCode" | "city" | "country" | "linkedin" | "website" | "dob">;
  answers: ApplyAnswers;
  /** The cover letter's paragraphs, for "message" fields; empty when there's no letter. */
  letterParagraphs: string[];
}): AnswerSet {
  const { first, last } = splitName(basics.name);
  const street = [basics.street.trim(), basics.houseNumber.trim()].filter(Boolean).join(" ");
  return {
    firstName: first,
    lastName: last,
    fullName: basics.name.trim(),
    email: basics.email.trim(),
    phone: basics.phone.trim(),
    street: street || answers.street.trim(),
    houseNumber: basics.houseNumber.trim(),
    postalCode: basics.postalCode.trim() || answers.postalCode.trim(),
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
export const PRIVATE_KEYS: ReadonlySet<AnswerKey> = new Set<AnswerKey>(["email", "phone", "street", "houseNumber", "postalCode", "dob"]);
