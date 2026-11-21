import { permitClaimed, type ApplyAnswers } from "@/lib/apply/answers";
import { germanFit, profileGerman } from "@/lib/german-need";
import type { ProfileData } from "@/lib/profile";

// The recruiter's eye (jobauto fork): the doubts a German recruiter has in
// the first thirty seconds with a foreign candidate's application, and
// rarely asks about: can she work here, does she live here, is her German
// enough, is her degree recognised, has she worked in Germany. For each,
// whether her documents already answer it, and what would. Worked out in
// code; the answers that settle them go into the cover letter (readinessLines).

export type DoubtId = "permit" | "location" | "german" | "degree" | "local";

export type Doubt = {
  id: DoubtId;
  /** What the recruiter wonders. */
  question: string;
  /** Her documents already answer it. */
  answered: boolean;
  /** What would answer it, when they don't. */
  fix: string;
};

const PERMIT = /arbeitserlaubnis|arbeitsberechtigung|aufenthalts(?:titel|erlaubnis)|niederlassungserlaubnis|blaue karte|blue card|work permit|right to work|permission to work|allowed to work|eu citizen|eu-bürger|without (?:a )?(?:visa|sponsorship)|ohne visum|no visa|keine sponsor/i;
const GERMAN_STATED = /\b(?:deutsch|german)\b[^.\n]{0,60}\b(?:a1|a2|b1|b2|c1|c2|kurs|course|lerne|learning|niveau|level)\b|\b(?:a1|a2|b1|b2|c1|c2)\b[^.\n]{0,30}\b(?:deutsch|german)\b/i;
const DEGREE_STATED = /\bzab\b|zeugnisbewertung|anabin|anerkannt|anerkennung|recogni[sz]ed in germany|equivalent to a german/i;
const GERMAN_SCHOOL = /universit[äa]t|hochschule|\bfh\b|\btu\b|fachhochschule|akademie|berufsschule|\bihk\b|germany|deutschland/i;
const GERMAN_PLACE = /germany|deutschland|\bde\b|hamburg|berlin|m[üu]nchen|munich|frankfurt|k[öo]ln|cologne|d[üu]sseldorf|stuttgart|hannover|bremen|leipzig|dresden|n[üu]rnberg/i;
const EU_FRAME = /\b(?:eu|european|esma|eu-weit|eu-wide|europ[äa]isch)\b/i;

export type EyeInput = {
  profile: Pick<ProfileData, "basics" | "languages" | "education" | "experience">;
  answers: Pick<ApplyAnswers, "workPermit" | "confirmed" | "germanCourse" | "degreeRecognition">;
  posting: string;
  /** The resume's and the letter's text as they are now. */
  documents: string;
};

/** The doubts that apply to this application, answered or not. */
export function recruiterDoubts({ profile, answers, posting, documents }: EyeInput): Doubt[] {
  const doubts: Doubt[] = [];
  const country = profile.basics.country.trim();
  const inGermany = GERMAN_PLACE.test(country) || GERMAN_PLACE.test(profile.basics.city);

  doubts.push({
    id: "permit",
    question: "Can she work in Germany, or would we have to sponsor a visa?",
    answered: PERMIT.test(documents),
    fix: permitClaimed(answers)
      ? "Say you may work in Germany without a visa or sponsorship. New letters do, from your standard answers."
      : answers.workPermit
        ? "Confirm your work permit in the standard answers on the Apply tab: until you save them, letters don't mention it."
        : "Say which permit you hold, or what it would take.",
  });

  doubts.push({
    id: "location",
    question: "Does she live here, or would she have to move?",
    answered: inGermany && Boolean(profile.basics.city.trim()) && documents.toLowerCase().includes(profile.basics.city.trim().toLowerCase()),
    fix: inGermany ? "Show your city on the resume: it's in your profile's basics." : "Say where you live and when you can be in Germany.",
  });

  const german = germanFit(posting, profileGerman(profile.languages));
  if (german.verdict !== "fits" || german.need.adLanguage === "German") {
    doubts.push({
      id: "german",
      question: "Is her German enough for the job?",
      answered: GERMAN_STATED.test(documents),
      fix: answers.germanCourse.trim()
        ? "Say your level and the course you're in. New letters do, from your standard answers."
        : "Add your German course (and exam date) to your standard answers: an honest level with a plan reads far better than silence.",
    });
  }

  const foreignDegree = profile.education.some((entry) => (entry.degree || entry.school).trim() && !GERMAN_SCHOOL.test(`${entry.school} ${entry.notes}`));
  if (foreignDegree) {
    doubts.push({
      id: "degree",
      question: "Is her degree recognised here?",
      answered: DEGREE_STATED.test(documents),
      fix: answers.degreeRecognition.trim()
        ? "Mention its German equivalence. New letters do, from your standard answers."
        : "Get a ZAB Zeugnisbewertung (the official German assessment of a foreign degree) and add it to your standard answers.",
    });
  }

  const roles = profile.experience.filter((role) => !role.volunteering && (role.location.trim() || role.company.trim()));
  if (roles.length > 0 && !roles.some((role) => GERMAN_PLACE.test(`${role.location} ${role.company}`))) {
    doubts.push({
      id: "local",
      question: "She hasn't worked in Germany: will her experience carry over?",
      answered: EU_FRAME.test(documents),
      fix: "Say that the rules you worked under (EMIR, MiFIR) are the same across the EU, so your experience applies as it is.",
    });
  }
  return doubts;
}

/**
 * What settles these doubts, from her standard answers and profile, for the
 * cover letter to say where a German employer would wonder.
 */
export function readinessLines(profile: Pick<ProfileData, "basics" | "languages">, answers: Pick<ApplyAnswers, "workPermit" | "confirmed" | "germanCourse" | "degreeRecognition">): string[] {
  const german = profileGerman(profile.languages);
  return [
    permitClaimed(answers) ? "Allowed to work in Germany without a visa or sponsorship" : "",
    profile.basics.city.trim() ? `Lives in ${[profile.basics.city.trim(), profile.basics.country.trim()].filter(Boolean).join(", ")}` : "",
    german !== "NONE" ? `German: ${german}${answers.germanCourse.trim() ? `, ${answers.germanCourse.trim()}` : ""}` : answers.germanCourse.trim() ? `German: ${answers.germanCourse.trim()}` : "",
    answers.degreeRecognition.trim() ? `Degree recognition: ${answers.degreeRecognition.trim()}` : "",
  ].filter(Boolean);
}
