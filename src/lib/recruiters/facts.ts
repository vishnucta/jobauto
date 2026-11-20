import type { ApplyAnswers } from "@/lib/apply/answers";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { languageLevelLabel, type ProfileData } from "@/lib/profile";

import type { OutreachFacts } from "./types";

/**
 * What a message to a recruiter may say about the user: what the profile
 * has, nothing more. With the standard answers, a brief for agencies too:
 * the roles she's after (the profile's own search words), where she'd work,
 * her start and her salary expectation.
 */
export function outreachFacts(profile: Pick<ProfileData, "basics" | "languages"> & Partial<Pick<ProfileData, "skills" | "experience">>, answers?: Pick<ApplyAnswers, "mobility" | "startDate" | "salary">, today = new Date()): OutreachFacts {
  const targets = profile.skills && profile.experience ? searchChips(searchWords({ basics: profile.basics, skills: profile.skills, experience: profile.experience }, today), 2) : [];
  const brief = answers && (targets.length > 0 || answers.mobility.trim() || answers.startDate.trim() || answers.salary.trim())
    ? { targets, mobility: answers.mobility.trim(), start: answers.startDate.trim(), salary: answers.salary.trim() }
    : undefined;
  return {
    ...(brief ? { brief } : {}),
    name: profile.basics.name.trim(),
    headline: profile.basics.headline.trim(),
    city: profile.basics.city.trim(),
    languages: profile.languages.map((language) => ({ name: language.name, level: languageLevelLabel(language.level) })),
  };
}
