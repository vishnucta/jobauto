import { z } from "zod";

import type { Extracted } from "@/lib/application-data";
import type { ProfileData } from "@/lib/profile";
import type { WorkSample } from "@/lib/work-sample";

import { factSources, guardSources, unverifiedFacts } from "../fact-guard";

import { applicationFacts, candidateFacts, CREATIVITY, jobForPrompt, languageRule, NO_EM_DASHES, postingForPrompt, profileForPrompt, system, truthfulness, UNTRUSTED_POSTING, type Task } from "./prompt-parts";

export const WRITE_WORK_SAMPLE_VERSION = "write-work-sample@1";

const answerSchema = z.object({
  title: z.string(),
  situation: z.string(),
  phases: z.array(z.object({ heading: z.string(), steps: z.array(z.string()) })),
  proof: z.array(z.string()),
  closing: z.string(),
});

const INSTRUCTIONS = `You write a one-page work sample for a job candidate, as JSON: "My first 90 days" in this job, to send with the application. It shows how the candidate would do the work, so the reader judges their competence, not only their CV.

- title: "My first 90 days as <role> at <company>", in the document's language.
- situation: two or three sentences on what the job is there to run, fix or build, as the posting suggests it. Say "as I read the posting" where you infer; never present a guess about the company as fact.
- phases: exactly three, headed like "Days 1–30: …", "Days 31–60: …", "Days 61–90: …" (in the document's language), each with three or four concrete steps a person in this role would really take: what they'd check, set up, reconcile, document or deliver, named in the field's own terms (e.g. EMIR/MiFIR reports, reconciliations, controls, regulator deadlines). Specific to this job, not generic onboarding.
- proof: two or three short lines on where the candidate has done this kind of work before, each from one role in the profile and only what it says (no numbers it doesn't give).
- closing: one sentence that invites a conversation about the plan.
- Keep it to one printed page: about 300–380 words in all.`;

export type WorkSampleInput = {
  profile: ProfileData;
  extracted: Extracted | null;
  posting: string;
  company: string;
  role: string;
  /** What the candidate tells the AI for this application (APP-15). */
  facts: string[];
};

/** Writes the work sample for one application (jobauto fork). */
export const writeWorkSample: Task<WorkSampleInput, Omit<WorkSample, "inMappe">> = async (provider, input, options) => {
  const { profile, extracted, posting, company, role, facts } = input;
  const answer = await provider.complete({
    task: "write-work-sample",
    system: system(INSTRUCTIONS, truthfulness(options.strict), candidateFacts(profile, facts), CREATIVITY[options.creativity], languageRule(options.language ?? extracted?.language ?? null), UNTRUSTED_POSTING, NO_EM_DASHES),
    messages: [
      {
        role: "user",
        content: [
          `The candidate's profile:\n${profileForPrompt(profile)}`,
          `The job: ${[role, company].filter(Boolean).join(" at ") || "see the posting"}`,
          extracted && `What the posting asks for:\n${jobForPrompt(extracted, null)}`,
          posting.trim() && `The posting:\n${postingForPrompt(posting)}`,
          applicationFacts(facts),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: answerSchema,
    schemaName: "work_sample",
    creativity: options.creativity,
    signal: options.signal,
  });

  const tidy = (text: string) => text.trim();
  const phases = answer.phases
    .map((phase) => ({ heading: tidy(phase.heading), steps: phase.steps.map(tidy).filter(Boolean) }))
    .filter((phase) => phase.heading && phase.steps.length > 0)
    .slice(0, 3);
  const proof = answer.proof.map(tidy).filter(Boolean);
  // Only what she says about herself is checked: the plan is a plan.
  const sources = options.strict ? factSources([guardSources(profile, extracted, posting, facts).text]) : null;
  return {
    data: { title: tidy(answer.title), situation: tidy(answer.situation), phases, proof, closing: tidy(answer.closing), unverified: sources ? unverifiedFacts(proof.join("\n"), sources) : [] },
    promptVersion: WRITE_WORK_SAMPLE_VERSION,
  };
};
