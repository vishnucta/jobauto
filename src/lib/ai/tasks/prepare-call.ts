import { z } from "zod";

import type { Extracted } from "@/lib/application-data";
import { ANSWER_NAMES, answerLines, flaggedSentences, prepGaps, salaryLine, unsavedStudyLength, type CallAnswers, type CallPrep } from "@/lib/call-prep";
import type { ProfileData } from "@/lib/profile";

import { factSources, guardSources, unverifiedFacts } from "../fact-guard";

import { applicationFacts, candidateFacts, CREATIVITY, jobForPrompt, NO_EM_DASHES, postingForPrompt, profileForPrompt, system, truthfulness, UNTRUSTED_POSTING, type Task } from "./prompt-parts";

// @2 (jobauto fork): her standard answers (start date, notice period, salary, permit, German course), never made up.
export const PREPARE_CALL_VERSION = "prepare-call@2";

/** Before any call, so an empty answer set (practice, an older caller) still says nothing is saved. */
const NO_ANSWERS: CallAnswers = { startDate: "", noticePeriod: "", salary: "", workPermit: null, germanCourse: "" };

const pair = z.object({ de: z.string(), en: z.string() });

const answerSchema = z.object({
  questions: z.array(z.object({ question: pair, answer: pair })),
  salary: pair,
  stories: z.array(z.object({ title: z.string(), situation: z.string(), action: z.string(), result: z.string() })),
  toAsk: z.array(pair),
  gaps: z.array(z.string()),
});

const INSTRUCTIONS = `You prepare a job candidate for the first phone call with an employer in Germany, as JSON. The call usually opens in German. The candidate's German is at the level given below, so every German answer must be something they can actually say at that level.

- questions: the 8 to 10 questions such a first call asks most, in this order where they fit: "Erzählen Sie etwas über sich.", "Warum haben Sie sich bei uns beworben?", "Was wissen Sie über unser Unternehmen?" (answer only from the posting), "Was sind Ihre Stärken?", "Warum möchten Sie wechseln?" or the reason they are looking, "Wann können Sie anfangen?", "Wie sind Ihre Deutschkenntnisse?", plus one or two about the job's main requirements. Each has question.de (as an interviewer would say it, formal Sie) and question.en (its meaning), answer.de (what the candidate says) and answer.en (the same in English).
- answer.de: short, simple sentences of at most about 12 words, in present or perfect tense, common words, formal Sie towards them. Three to five sentences. Plain enough for the candidate's level; for A2 and B1, nothing a learner would stumble over. Name tools and terms as they are (SAP, EMIR, MiFIR, Excel).
- answer.en: the same answer in natural English, a little fuller where that helps the English part of a later interview.
- The answer about German says honestly what the profile shows about the candidate's German and that they are learning, without excuses.
- The candidate's standard answers are given below: start date, notice period, salary expectation, work permit, German course. Wherever an answer touches one ("Wann können Sie anfangen?", notice, salary, permit, how long they've learned German), say exactly that, in the answer's language. Never give any other start date, notice period, salary, permit status or length of study. For one that isn't saved, write "[…]" in its place: the candidate fills it in. Without a German course, say nothing about how long they have been learning German.
- salary: what to say when asked about salary expectations, in German and English, with "[…]" in place of the figure: the candidate fills it in. Never name a figure.
- stories: three short stories for "Tell me about a time…", in English, each from one role in the profile: title (a few words), situation, action, result (one or two sentences each). Use only what the profile says happened; no numbers it doesn't give.
- toAsk: three questions the candidate can ask at the end, German and English, simple, about the team, the first months and the next steps.
- gaps: what the candidate must decide or look up before the call because the profile doesn't say it, as short questions, e.g. "What is your notice period?" or "What salary will you ask for?". Where an answer depends on one, write "[…]" in its place.`;

export type PrepareCallInput = {
  profile: ProfileData;
  extracted: Extracted | null;
  /** The posting as pasted or found. */
  posting: string;
  company: string;
  role: string;
  /** The candidate's German, e.g. "A2", or "none". */
  german: string;
  /** What the candidate tells the AI for this application (APP-15). */
  facts: string[];
  /** Her standard answers (callAnswers, jobauto fork); without them, none are saved. */
  answers?: CallAnswers;
};

/** Writes the phone-screen prep pack for one application (Phase 3). */
export const prepareCall: Task<PrepareCallInput, CallPrep> = async (provider, input, options) => {
  const { profile, extracted, posting, company, role, german, facts, answers = NO_ANSWERS } = input;
  const { known, missing } = answerLines(answers);
  const answerText = [
    known.length > 0 && `The candidate's standard answers, used for every application:\n${known.map((line) => `- ${line}`).join("\n")}`,
    missing.length > 0 && `Not saved yet, so write "[…]" wherever an answer needs one, never a made-up value: ${missing.map((id) => ANSWER_NAMES[id]).join(", ")}.`,
  ];
  const answer = await provider.complete({
    task: "prepare-call",
    system: system(INSTRUCTIONS, `The candidate's German: ${german}.`, truthfulness(options.strict), candidateFacts(profile, facts), CREATIVITY[options.creativity], UNTRUSTED_POSTING, NO_EM_DASHES),
    messages: [
      {
        role: "user",
        content: [
          `The candidate's profile:\n${profileForPrompt(profile)}`,
          `The job: ${[role, company].filter(Boolean).join(" at ") || "see the posting"}`,
          extracted && `What the posting asks for:\n${jobForPrompt(extracted, null)}`,
          posting.trim() && `The posting:\n${postingForPrompt(posting)}`,
          applicationFacts(facts),
          ...answerText,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: answerSchema,
    schemaName: "call_prep",
    creativity: options.creativity,
    signal: options.signal,
  });

  const trim = (value: { de: string; en: string }) => ({ de: value.de.trim(), en: value.en.trim() });
  const questions = answer.questions.map((entry) => ({ question: trim(entry.question), answer: trim(entry.answer) })).filter((entry) => entry.question.de && entry.answer.de);
  const stories = answer.stories.map((story) => ({ title: story.title.trim(), situation: story.situation.trim(), action: story.action.trim(), result: story.result.trim() })).filter((story) => story.title);
  // The answers are what she'd say about herself: the fact guard reads them as it reads a letter, her standard answers included.
  const sources = options.strict ? factSources([guardSources(profile, extracted, posting, [...facts, ...known]).text]) : null;
  const said = [...questions.map((entry) => entry.answer.en), ...stories.flatMap((story) => [story.situation, story.action, story.result])].join("\n");
  return {
    data: {
      questions,
      // Her saved salary, written in code; without one, the AI's line with "[…]".
      salary: salaryLine(answers) ?? trim(answer.salary),
      stories,
      toAsk: answer.toAsk.map(trim).filter((entry) => entry.de),
      gaps: prepGaps(answers, answer.gaps.map((gap) => gap.trim()).filter(Boolean)),
      // Each flag in the sentence it's in, which she can check, and how long she's learned German when nothing she saved says (jobauto fork).
      unverified: [...new Set([...(sources ? flaggedSentences(said, unverifiedFacts(said, sources)) : []), ...unsavedStudyLength(said, answers)])],
    },
    promptVersion: PREPARE_CALL_VERSION,
  };
};
