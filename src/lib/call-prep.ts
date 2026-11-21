import { z } from "zod";

import type { ApplyAnswers } from "@/lib/apply/answers";

// The phone-screen prep pack (Phase 3, jobauto fork): for one application,
// the questions a German first call asks, with her answers in short German
// she can say and the English beside them, a salary line, the sentence for
// when German runs out, three short stories from her own roles, and
// questions to ask them. Kept on the application (Application.prep) and
// shared by the server, the Call prep tab and the connector.

const pair = z.object({ de: z.string(), en: z.string() });
export type Pair = z.output<typeof pair>;

export const callPrepSchema = z.object({
  /** "Erzählen Sie etwas über sich", "Warum diese Stelle?"…, each with her answer. */
  questions: z.array(z.object({ question: pair, answer: pair })),
  /** What to say when asked about salary; "[…]" where she has to fill in a figure. */
  salary: pair,
  /** Short stories from her roles for "Tell me about a time…", in English: the interview after the call is often in English. */
  stories: z.array(z.object({ title: z.string(), situation: z.string(), action: z.string(), result: z.string() })),
  /** Questions she can ask them at the end. */
  toAsk: z.array(pair),
  /** What the profile couldn't answer, e.g. "What is your notice period?". */
  gaps: z.array(z.string()),
  /** Statements in the answers that the profile, the posting and her facts don't back (fact guard). */
  unverified: z.array(z.string()).default([]),
});
export type CallPrep = z.output<typeof callPrepSchema>;

/** The stored pack, or null when there is none or it doesn't read. */
export function callPrepOf(value: unknown): CallPrep | null {
  const parsed = callPrepSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The sentence for when German runs out, practised until it comes without thinking. Always the same, so it's never left to the AI. */
export const FALLBACK: Pair = {
  de: "Entschuldigung, mein Deutsch ist noch auf A2-Niveau. Ich lerne jeden Tag weiter. Können wir bitte auf Englisch weitermachen?",
  en: "Sorry, my German is still at A2 level. I keep learning every day. Could we please continue in English?",
};

/** Asking them to say it again, slower: the second sentence worth knowing by heart. */
export const SAY_AGAIN: Pair = {
  de: "Könnten Sie das bitte noch einmal langsamer wiederholen?",
  en: "Could you please repeat that a little more slowly?",
};

/** The statuses on reaching which the pack is prepared, unless there is one. */
export const PREP_STATUSES = ["SCREENING", "INTERVIEW"] as const;

/** The background job's key, to find a pack being prepared after a reload. */
export const prepJobKey = (applicationId: string) => `call-prep:${applicationId}`;

/** Lower case, letters only, umlauts kept: words to compare a spoken answer with the written one. */
const words = (text: string) =>
  text
    .toLocaleLowerCase("de-DE")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * How much of the written answer the spoken one said, 0–100: the share of
 * its words heard, each counted as often as it's written. Not a grade, a
 * sign of how close the practice came.
 */
export function spokenMatch(written: string, spoken: string): number {
  const expected = words(written);
  if (expected.length === 0) return 0;
  const heard = new Map<string, number>();
  for (const word of words(spoken)) heard.set(word, (heard.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of expected) {
    const left = heard.get(word) ?? 0;
    if (left > 0) {
      found += 1;
      heard.set(word, left - 1);
    }
  }
  return Math.round((found / expected.length) * 100);
}

/**
 * Her standard answers as call prep uses them (jobauto fork): saved once
 * (applyAnswers) and said the same way in every call. A work
 * permit she never confirmed is no answer; "" is one she hasn't saved.
 */
export type CallAnswers = { startDate: string; noticePeriod: string; salary: string; workPermit: boolean | null; germanCourse: string };

export function callAnswers(answers: Pick<ApplyAnswers, "startDate" | "noticePeriod" | "salary" | "workPermit" | "confirmed" | "germanCourse">): CallAnswers {
  return {
    startDate: answers.startDate.trim(),
    noticePeriod: answers.noticePeriod.trim(),
    salary: answers.salary.trim(),
    workPermit: answers.confirmed === false ? null : answers.workPermit,
    germanCourse: answers.germanCourse.trim(),
  };
}

/** The standard answers call prep needs, by name. */
export const ANSWER_NAMES = { startDate: "earliest start date", noticePeriod: "notice period", salary: "salary expectation", workPermit: "work permit" } as const;
type AnswerId = keyof typeof ANSWER_NAMES;

/** What a model's "decide before the call" item asks about, to drop the ones her answers settle. */
const ASKS_ABOUT: Record<AnswerId, RegExp> = {
  startDate: /\bstart|anfangen|beginn|eintritt|availab|verf[uü]gbar/i,
  noticePeriod: /\bnotice|k[uü]ndigung/i,
  salary: /salary|gehalt|pay\b|compensation/i,
  workPermit: /permit|visa|sponsor|arbeitserlaubnis|aufenthalt/i,
};

/**
 * The answers for the prompt, as lines ("Earliest start date: sofort"), and
 * the ones she hasn't saved, which the pack leaves as "[…]" for her to fill in.
 */
export function answerLines(answers: CallAnswers): { known: string[]; missing: AnswerId[] } {
  const known = [
    answers.startDate && `Earliest start date: ${answers.startDate}${/^\d{4}-\d{2}-\d{2}$/.test(answers.startDate) ? " (a date: say it as the language says dates)" : ""}`,
    answers.noticePeriod && `Notice period: ${answers.noticePeriod}`,
    answers.salary && `Salary expectation: ${answers.salary}`,
    answers.workPermit !== null && (answers.workPermit ? "Work permit: may work in Germany without a visa or sponsorship" : "Work permit: needs a visa or sponsorship to work in Germany"),
    answers.germanCourse && `German course: ${answers.germanCourse}`,
  ].filter((line): line is string => Boolean(line));
  const missing = (Object.keys(ANSWER_NAMES) as AnswerId[]).filter((id) => (id === "workPermit" ? answers.workPermit === null : !answers[id]));
  return { known, missing };
}

/**
 * What to settle before the call: one line per standard answer she hasn't
 * saved, pointing to where it's saved, then the model's own, less those her
 * saved answers already settle.
 */
export function prepGaps(answers: CallAnswers, written: readonly string[]): string[] {
  const { missing } = answerLines(answers);
  const settled = (Object.keys(ANSWER_NAMES) as AnswerId[]).filter((id) => !missing.includes(id));
  const own = missing.map((id) => `Your ${ANSWER_NAMES[id]} isn't in your standard answers. Fill it in under Settings → Standard answers, then prepare again.`);
  return [...own, ...written.filter((gap) => !settled.some((id) => ASKS_ABOUT[id].test(gap)) && !missing.some((id) => ASKS_ABOUT[id].test(gap)))];
}

/** The salary line, written from her saved answer so it's never made up; null leaves it to the AI, with "[…]". */
export function salaryLine(answers: CallAnswers): Pair | null {
  return answers.salary ? { de: `Meine Gehaltsvorstellung liegt bei ${answers.salary}.`, en: `My salary expectation is ${answers.salary}.` } : null;
}

/**
 * The whole sentences the fact guard's flags are in, to check against the
 * profile: "Europe, 1, three" alone means nothing to her. A flag no sentence
 * holds stays as it is.
 */
export function flaggedSentences(text: string, flags: readonly string[]): string[] {
  const sentences = sentencesOf(text);
  const found: string[] = [];
  for (const flag of flags) {
    const sentence = sentences.find((entry) => entry.includes(flag));
    const shown = sentence ?? flag;
    if (!found.includes(shown)) found.push(shown);
  }
  return found;
}

const sentencesOf = (text: string) =>
  text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const STUDY_LENGTH = /\b(?:learn(?:ing|ed|t)?|stud(?:y|ying|ied)|taking)\b[^.!?\n]{0,30}\bGerman\b[^.!?\n]{0,10}\b(?:for|since)\b|\bGerman (?:for|since) (?:a|one|two|\d+|last)\b/i;

/**
 * The sentences that say how long she's been learning German when her saved
 * German course doesn't (the audit's "for a year"): an answer she'd read out
 * word for word in an A2 call, made up.
 */
export function unsavedStudyLength(text: string, answers: Pick<CallAnswers, "germanCourse">): string[] {
  return answers.germanCourse ? [] : sentencesOf(text).filter((sentence) => STUDY_LENGTH.test(sentence));
}
