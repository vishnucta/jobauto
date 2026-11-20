import "server-only";

import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import type { ProfileData } from "@/lib/profile";
import { seenPostings } from "@/lib/seen-postings";

import { hiddenTitles, REPORTING_PROFILE, REPORTING_TERMS, type HiddenTitle } from "./hidden-titles";

/** Words too general to tell what a posting asks for. */
const GENERIC = /^(excel|english|deutsch|german|ms office|microsoft office|word|powerpoint|communication|teamwork|sql)$/i;

/** Hidden titles for her: from every posting seen, against her skills and her field's words, leaving out what she searches already. */
export async function loadHiddenTitles(profile: Pick<ProfileData, "basics" | "skills" | "experience">, now = new Date()): Promise<HiddenTitle[]> {
  const seen = await seenPostings();
  const searched = new Set<string>([...searchChips(searchWords(profile, now), 12), ...seen.searchedKeywords]);

  const profileText = [profile.basics.headline, profile.basics.summary, ...profile.experience.flatMap((role) => [role.role, role.bullets]), ...profile.skills.map((skill) => skill.name)].join(" ");
  const terms = [...profile.skills.map((skill) => skill.name.trim()).filter((name) => name.length > 2 && !GENERIC.test(name)), ...(REPORTING_PROFILE.test(profileText) ? REPORTING_TERMS : [])];
  return hiddenTitles(seen.postings, terms, [...searched]);
}
