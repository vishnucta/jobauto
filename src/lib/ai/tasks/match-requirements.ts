import { z } from "zod";

import { matchSchema, type Extracted, type Match } from "@/lib/application-data";
import { experienceMonths, formatMonthYear, languageLevelLabel, paidRoles, sameName, type CertificationItem, type ProfileData } from "@/lib/profile";

import { system, UNTRUSTED_POSTING, type Task } from "./prompt-parts";

export const MATCH_REQUIREMENTS_VERSION = "match-requirements@2";

// The model only says which profile skill, language or certification each
// requirement is about; code decides covered, partial or gap from the profile itself, so the
// match is deterministic and explainable (NEW-4, E7-4).
const answerSchema = z.object({
  matches: z.array(
    z.object({
      /** The requirement's number in the list. */
      requirement: z.number().int(),
      /** A skill from the profile's list, spelled as there, or null. */
      skill: z.string().nullable(),
      /** A language from the profile's list, or null. */
      language: z.string().nullable(),
      /** A certification from the profile's list, spelled as there, or null (#364). */
      certification: z.string().nullable(),
    }),
  ),
});

const INSTRUCTIONS = `You compare a job's requirements with a candidate's skills, languages and certifications.

For each numbered requirement, answer which ONE of the candidate's skills it is about, if any, which of the candidate's languages, if any, and which ONE of the candidate's certifications meets it, if any. Copy names exactly as they appear in the candidate's lists. Match on meaning ("Strong prototyping skills in Figma" is about "Figma"; "Has built or maintained a design system" is about "Design systems"; "Security certifications such as CEH" is met by "Certified Ethical Hacker (CEH v12)"), but don't stretch: when nothing really fits, answer null. A certification only counts when the requirement asks for that certification or one of its kind. Answer every requirement once.`;

export type MatchInput = { requirements: Extracted["requirements"]; profile: ProfileData; today?: Date };

/** NEW-4: each requirement covered, partial or a gap, with its evidence. */
export const matchRequirements: Task<MatchInput, Match> = async (provider, { requirements, profile, today = new Date() }, { signal }) => {
  const needsModel = requirements.some((requirement) => requirement.kind !== "years");
  const answer = needsModel
    ? await provider.complete({
        task: "match-requirements",
        system: system(INSTRUCTIONS, UNTRUSTED_POSTING),
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                requirements: requirements.map((requirement, index) => ({ number: index, text: requirement.text, kind: requirement.kind, skill: requirement.skill })),
                candidateSkills: profile.skills.map((skill) => skill.name),
                candidateLanguages: profile.languages.map((language) => language.name),
                candidateCertifications: named(profile.certifications).map((entry) => entry.name),
              },
              null,
              2,
            ),
          },
        ],
        schema: answerSchema,
        schemaName: "requirement_matches",
        creativity: "FAITHFUL",
        effort: "low",
        signal,
      })
    : { matches: [] };

  const mapped = new Map(answer.matches.map((match) => [match.requirement, match]));
  return {
    data: matchSchema.parse({
      items: requirements.map((requirement, index) => classify(requirement, mapped.get(index), profile, today)),
    }),
    promptVersion: MATCH_REQUIREMENTS_VERSION,
  };
};

type Item = Match["items"][number];

function classify(
  requirement: Extracted["requirements"][number],
  mapped: { skill: string | null; language: string | null; certification: string | null } | undefined,
  profile: ProfileData,
  today: Date,
): Item {
  const base = { requirement: requirement.text, skill: null, experienceIds: [] as string[], note: null };

  if (requirement.kind === "years") {
    // Years of experience are paid roles' (#294).
    const paid = paidRoles(profile.experience);
    const dated = paid.filter((entry) => entry.startYear !== null);
    if (dated.length === 0) return { ...base, result: "gap", note: "Add your experience to check this" };
    const first = dated.reduce(
      (earliest, entry) => (entry.startYear! * 12 + (entry.startMonth ?? 1) < earliest.startYear! * 12 + (earliest.startMonth ?? 1) ? entry : earliest),
      dated[0],
    );
    const count = paid.length;
    const roles = `${count} ${count === 1 ? "role" : "roles"} in your profile, since ${formatMonthYear(first.startYear, first.startMonth)}`;
    const years = Math.floor(experienceMonths(profile, today) / 12);
    return years >= (requirement.years ?? 0)
      ? { ...base, result: "covered", note: roles }
      : { ...base, result: "gap", note: `${roles} (about ${years} ${years === 1 ? "year" : "years"})` };
  }

  // Names must be the profile's own: a model can't add a skill by misspelling one.
  const language = profile.languages.find(
    (entry) => (mapped?.language && sameName(entry.name, mapped.language)) || (requirement.language && sameName(entry.name, requirement.language)),
  );
  if (requirement.kind === "language" || (language && !mapped?.skill)) {
    return language
      ? { ...base, result: "covered", skill: language.name, note: `${language.name}: ${languageLevelLabel(language.level)}` }
      : { ...base, result: "gap", note: "Not in your profile" };
  }

  // A certification the profile has, by its own name: a model can't add one by misspelling it (#364).
  const certification = mapped?.certification ? named(profile.certifications).find((entry) => sameName(entry.name, mapped.certification!)) : undefined;
  if (certification) return certified(base, certification, today);

  // The model's pick first, then the skill the posting names; spelling may differ a little.
  const skill =
    profile.skills.find((entry) => mapped?.skill && sameSkill(entry.name, mapped.skill)) ??
    profile.skills.find((entry) => requirement.skill && sameSkill(entry.name, requirement.skill));
  if (!skill) {
    return {
      ...base,
      result: "gap",
      note: requirement.kind === "skill" ? "Not in your profile yet" : "Nothing in your profile for this yet",
    };
  }
  const roles = profile.experience.filter((entry) => entry.skillIds.includes(skill.id));
  return roles.length > 0
    ? {
        ...base,
        result: "covered",
        skill: skill.name,
        experienceIds: roles.map((entry) => entry.id),
        note: `Used at ${[...new Set(roles.map((entry) => entry.company || entry.role))].join(", ")}`,
      }
    : { ...base, result: "partial", skill: skill.name, note: "In your skills, but not linked to a role yet" };
}

/** Certifications with a name, whether or not they're shown on resumes: all are the user's own. */
const named = (certifications: readonly CertificationItem[]) => certifications.filter((entry) => entry.name.trim() !== "");

/** Covered by a certification, with it and its issuer as the evidence; partial once it has expired. */
function certified(base: Omit<Item, "result">, certification: CertificationItem, today: Date): Item {
  const evidence = [certification.name.trim(), certification.issuer.trim()].filter(Boolean).join(", ");
  const { expiryYear, expiryMonth } = certification;
  // An expiry month is the last month it's valid; without one, the year's end.
  const expired =
    expiryYear !== null && expiryYear * 12 + (expiryMonth ?? 12) < today.getFullYear() * 12 + today.getMonth() + 1;
  return expired
    ? { ...base, result: "partial", note: `${evidence}, expired ${formatMonthYear(expiryYear, expiryMonth)}` }
    : { ...base, result: "covered", note: evidence };
}

/**
 * Whether two skill names mean the same skill, forgiving case, punctuation
 * and a plural: "Design system" is "Design systems", "UX-research" is "UX research".
 */
export function sameSkill(a: string, b: string): boolean {
  const key = (name: string) =>
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
      .join(" ");
  return key(a) === key(b);
}
