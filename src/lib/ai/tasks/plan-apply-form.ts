import { z } from "zod";

import { ANSWER_KEYS, ANSWER_LABELS, type AnswerKey } from "@/lib/apply/answers";
import type { ProfileData } from "@/lib/profile";

import { NO_EM_DASHES, postingForPrompt, profileForPrompt, system, truthfulness, UNTRUSTED_POSTING, type Task } from "./prompt-parts";

export const PLAN_APPLY_FORM_VERSION = "plan-apply-form@2";

// The apply assistant's second look at a form (Phase A, bewerbung fork):
// the deterministic matcher in src/lib/apply/fields.ts fills the obvious
// fields; the model decides the rest, field by field: which saved answer
// belongs in it, which option to pick, a short written answer to an open
// question, or that it's the candidate's own to fill. It never sees the
// candidate's contact details: the program types those.

/** A field the matcher left, as the model sees it. */
export type FieldForAdvice = {
  ref: string;
  label: string;
  /** "text", "textarea", "select", "radio", "date"… */
  type: string;
  /** The question it belongs to, for radios and grouped fields. */
  group: string;
  required: boolean;
  options: { value: string; text: string }[];
};

/** What the model decides for one field: exactly one of the four. */
export type FieldAdvice = {
  ref: string;
  key: AnswerKey | null;
  option: string | null;
  text: string | null;
  leave: string | null;
};

const answerSchema = z.object({
  fields: z.array(
    z.object({
      ref: z.string(),
      key: z.enum(ANSWER_KEYS).nullable(),
      option: z.string().nullable(),
      text: z.string().nullable(),
      leave: z.string().nullable(),
    }),
  ),
});

const INSTRUCTIONS = `You help a candidate fill in an employer's online application form, as JSON. A program has already filled the obvious fields (name, email, phone, address, the CV upload). You get the fields it could not fill, each with its label, its type, the question it belongs to and its options, together with the candidate's profile, the job posting and the cover letter already written for this job.

For each field, give exactly one of these, and null for the other three:
- key: the candidate's saved answer that belongs in this field, from the list of answer keys. The program types the actual value; you never see contact details.
- option: for a select or a group of radio buttons, the value of the option to pick, exactly as listed in its options.
- text: for a free-text question (such as "Why do you want to work with us?" or "Describe your experience with X"), a short answer of two to five sentences, in the language the form's label is written in, at the candidate's level in that language (given with the profile): at B1 or below, plain and simple, with short sentences and common words. The candidate must be able to say in an interview what you wrote. Build the answer from the profile and the cover letter only.
- leave: a short reason, in English, to leave the field to the candidate: it asks for a personal choice (salutation, title), a password or an account, a document you don't have, a date you can't know, a salary when none is saved, or something the profile doesn't answer.

Never answer questions about gender, age, nationality, religion, disability, family or any other protected characteristic: leave them. Never pick an option that opts the candidate into newsletters, talent pools or marketing. Never invent facts, employers, dates or certificates. Answer every field you were given, each once, by its ref.`;

export type PlanApplyFormInput = {
  fields: FieldForAdvice[];
  posting: string;
  profile: ProfileData;
  /** The cover letter's paragraphs, when there is one. */
  letterParagraphs: string[];
  /** The candidate's CEFR levels from the saved answers, so a free-text answer is written at a level they can defend. */
  germanLevel: string;
  englishLevel: string;
};

/** The keys the program can type, with what each holds, for the prompt. */
const ANSWER_KEY_LIST = ANSWER_KEYS.map((key) => ({ key, holds: ANSWER_LABELS[key] }));

/** Phase A: which saved answer, option or short text goes into each field the matcher left; contact details are never sent. */
export const planApplyForm: Task<PlanApplyFormInput, FieldAdvice[]> = async (provider, input, { strict, signal }) => {
  const answer = await provider.complete({
    system: system(INSTRUCTIONS, truthfulness(strict), NO_EM_DASHES, UNTRUSTED_POSTING),
    messages: [
      {
        role: "user",
        content: [
          `The candidate's profile:\n${profileForPrompt(input.profile)}`,
          `The candidate's language levels: German ${input.germanLevel}, English ${input.englishLevel}.`,
          `The answer keys the program can type:\n${JSON.stringify(ANSWER_KEY_LIST)}`,
          input.letterParagraphs.length > 0 ? `The cover letter written for this job:\n${input.letterParagraphs.join("\n\n")}` : null,
          `The posting:\n${postingForPrompt(input.posting)}`,
          `The fields to decide:\n${JSON.stringify(input.fields, null, 2)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: answerSchema,
    schemaName: "form_advice",
    creativity: "FAITHFUL",
    effort: "low",
    signal,
  });
  return { data: answer.fields, promptVersion: PLAN_APPLY_FORM_VERSION };
};
