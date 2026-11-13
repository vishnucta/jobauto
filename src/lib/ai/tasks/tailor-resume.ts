import { z } from "zod";

import { unitsSchema, type Extracted, type Match, type Unit } from "@/lib/application-data";
import { publicationLabel } from "@/lib/citation";
import { documentLabels, ENGLISH_LABELS, languagesLine, type DocumentLabels } from "@/lib/document-labels";
import { customSectionUnits } from "@/lib/custom-section-units";
import { detectLanguageName, knownLanguage } from "@/lib/document-language";
import { certificationLabel, resumeCertifications, resumeCustomSections, resumePublications, sameName, type ProfileData } from "@/lib/profile";
import { inEditorOrder, skillsText } from "@/lib/skill-groups";
import { plainText } from "@/lib/unit-text";

import { guardSources, guardUnits, inLanguage } from "../fact-guard";
import type { JsonCompletionRequest } from "../provider";

import {
  applicationFacts,
  candidateFacts,
  CREATIVITY,
  jobForPrompt,
  languageRule,
  NO_EM_DASHES,
  profileForPrompt,
  system,
  truthfulness,
  UNTRUSTED_POSTING,
  type Task,
} from "./prompt-parts";

export const TAILOR_RESUME_VERSION = "tailor-resume@9";

type Answer = z.infer<typeof answerSchema>;

const answerSchema = z.object({
  summary: z.string(),
  roles: z.array(z.object({ id: z.string(), bullets: z.array(z.string()) })),
  projects: z.array(z.object({ id: z.string(), bullets: z.array(z.string()) })),
  /** The profile's skills, most relevant first; leave out ones that don't help. */
  skills: z.array(z.string()),
  education: z.array(z.object({ id: z.string(), notes: z.string() })),
});

const INSTRUCTIONS = `You tailor a candidate's resume to one job, as JSON.

- summary: 2–3 sentences in the first person without "I" at the start of every sentence, about the candidate as this job would see them.
- roles: every role from the profile, by id, with 2–5 bullets each, volunteering too. Lead with what this job cares about, keep each bullet to one line, and start with a verb.
- projects: every project from the profile, by id, with 1–3 bullets each, written like the roles' bullets: what was built and what it shows that this job cares about.
- skills: the candidate's own skills, most relevant to this job first. Copy their names exactly as the profile spells them, even when everything else is in another language; you may leave out ones that don't help.
- education: every entry by id, with its notes shortened or left empty.
- The profile's certifications, publications and otherSections go on the resume word for word, so don't answer with them; the summary may mention them.`;

/**
 * Said last, after the long profile, where a model weighs it most. The profile
 * is written once for every job and may be in another language than this
 * resume: what comes from it is written again in the resume's language, not
 * copied over.
 */
function languageReminder(language: string | null | undefined): string | null {
  return language
    ? `Write the summary, every bullet and every education note in ${language}. The profile above may be in another language: write what you take from it in ${language} instead of copying it. Skill names stay as the profile spells them.`
    : null;
}

/** What the model writes as prose, for checking its language: not the skills (names), the languages line (built from the profile) or the citations. */
const proseOf = (units: Unit[]) =>
  units
    .filter((unit) => unit.id === "summary" || ["experience:", "project:", "education:"].some((prefix) => unit.id.startsWith(prefix)))
    .map((unit) => unit.text)
    .join("\n");

export type TailorInput = {
  profile: ProfileData;
  extracted: Extracted;
  match: Match | null;
  /** What the candidate tells the AI for this application (APP-15). */
  facts: string[];
  /** The posting as pasted, for the fact guard. */
  posting: string;
  /** Keep the profile's order of skills, set by hand, instead of the most relevant first (public issue 62). */
  keepSkillOrder?: boolean;
};

/** APP-4: the tailored resume as units (summary, each role, each project, skills, each degree, each certification, each publication, languages). */
export const tailorResume: Task<TailorInput, Unit[]> = async (provider, { profile, extracted, match, facts, posting, keepSkillOrder = false }, options) => {
  // The language it's written in: the one chosen, else the posting's. The model is told it outright: it sees what was read from the posting, not the posting, so "the posting's language" would leave it guessing, and the English profile wins.
  const language = options.language ?? extracted.language;
  const labels = documentLabels(language);
  const request: JsonCompletionRequest<Answer> = {
    task: "tailor-resume",
    system: system(
      INSTRUCTIONS,
      truthfulness(options.strict),
      candidateFacts(profile, facts),
      CREATIVITY[options.creativity],
      languageRule(language),
      UNTRUSTED_POSTING,
      NO_EM_DASHES,
    ),
    messages: [
      {
        role: "user",
        content: [
          `The candidate's profile:\n${profileForPrompt(profile)}`,
          `The job:\n${jobForPrompt(extracted, match)}`,
          applicationFacts(facts),
          languageReminder(language),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    schema: answerSchema,
    schemaName: "tailored_resume",
    creativity: options.creativity,
    signal: options.signal,
  };
  // The answer's type is named, so this is the structured-output call, not the plain-text one.
  const answer = await provider.complete<Answer>(request);
  // The languages line in the resume's language: the chosen one, or the posting's.
  let units = resumeUnits(profile, answer, labels, { keepSkillOrder });

  // A profile in another language pulls hard. When what the model wrote is clearly in a different one (a text that is too short or mixed says nothing), it is asked once more, with that said; if that fails, the first answer stands.
  const target = knownLanguage(language)?.name;
  const written = target ? detectLanguageName(proseOf(units)) : undefined;
  if (target && written && written !== target) {
    try {
      const again = await provider.complete<Answer>({
        ...request,
        messages: [
          ...request.messages,
          { role: "assistant", content: JSON.stringify(answer) },
          {
            role: "user",
            content: `That answer is written in ${written}, but this resume has to be written in ${target}. Answer again with the same JSON: the summary, every bullet and every education note in ${target}, with the same ids and the same facts. Keep names, employers and tools as they are, and skill names exactly as the profile spells them.`,
          },
        ],
      });
      units = resumeUnits(profile, again, labels, { keepSkillOrder });
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }
  // E6-6: in strict mode, note what the profile and posting don't back.
  return {
    data: options.strict ? guardUnits(units, inLanguage(guardSources(profile, extracted, posting, facts), language)) : units,
    promptVersion: TAILOR_RESUME_VERSION,
  };
};

/**
 * Turns the answer into units, trusting nothing: unknown roles, projects and
 * degrees are dropped, skills must be the profile's own, and a role or
 * project the model skipped keeps its bullets from the profile. The certifications, publications,
 * custom sections and languages come from the profile, all but the languages word for word (#293, #218, #298),
 * and languages with their levels in the words of `labels`.
 */
export function resumeUnits(profile: ProfileData, answer: z.infer<typeof answerSchema>, labels: DocumentLabels = ENGLISH_LABELS, { keepSkillOrder = false } = {}): Unit[] {
  // What the model wrote goes through the character normaliser; the profile's own text (a skipped role's bullets, the citations) stays as it is.
  const roles = new Map(answer.roles.map((role) => [role.id, role.bullets.map(plainText)]));
  const projects = new Map(answer.projects.map((project) => [project.id, project.bullets.map(plainText)]));
  const notes = new Map(answer.education.map((entry) => [entry.id, plainText(entry.notes)]));
  // Both names normalised for the comparison, so a skill the profile spells with a non-breaking hyphen still matches; the profile's spelling is what prints.
  const kept = [...new Set(answer.skills.flatMap((name) => profile.skills.find((skill) => sameName(plainText(skill.name), plainText(name))) ?? []))];
  // In the profile's order when the user set one (public issue 62), else as the model ranked them.
  const skills = keepSkillOrder ? inEditorOrder(profile.skills).filter((skill) => kept.includes(skill)) : kept;
  const units: Unit[] = [
    { id: "summary", label: "Summary", text: plainText(answer.summary).trim() },
    ...profile.experience.map((entry) => {
      const bullets = (roles.get(entry.id) ?? entry.bullets.split("\n")).map((line) => line.trim()).filter(Boolean);
      return { id: `experience:${entry.id}`, label: `${entry.company || entry.role} ${entry.volunteering ? "volunteering" : "role"}`, text: bullets.join("\n") };
    }),
    ...profile.projects.map((entry) => {
      const bullets = (projects.get(entry.id) ?? entry.bullets.split("\n")).map((line) => line.trim()).filter(Boolean);
      return { id: `project:${entry.id}`, label: `${entry.name || "Untitled"} project`, text: bullets.join("\n") };
    }),
    // Most relevant first, a line per group where its first skill comes (#280).
    { id: "skills", label: "Skills", text: skillsText(skills) },
    ...profile.education.map((entry) => ({
      id: `education:${entry.id}`,
      label: entry.degree || entry.school,
      text: (notes.get(entry.id) ?? entry.notes).trim(),
    })),
    ...resumeCertifications(profile.certifications).map((entry) => ({
      id: `certification:${entry.id}`,
      label: certificationLabel(entry.name),
      text: entry.name.trim(),
    })),
    ...resumePublications(profile.publications).map((entry) => ({
      id: `publication:${entry.id}`,
      label: publicationLabel(entry.citation),
      text: entry.citation.trim(),
    })),
    ...resumeCustomSections(profile.customSections).flatMap(customSectionUnits),
    {
      id: "languages",
      label: "Languages",
      text: languagesLine(profile.languages, labels),
    },
  ];
  return unitsSchema.parse(units);
}

/** The resume's units with the profile's own words, for adding a section to a resume that exists (#297). */
export function profileUnits(profile: ProfileData, labels: DocumentLabels = ENGLISH_LABELS): Unit[] {
  return resumeUnits(
    profile,
    { summary: profile.basics.summary, roles: [], projects: [], skills: inEditorOrder(profile.skills).map((skill) => skill.name), education: [] },
    labels,
  );
}
