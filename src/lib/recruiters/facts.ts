import { languageLevelLabel, type ProfileData } from "@/lib/profile";

import type { OutreachFacts } from "./types";

/** What a message to a recruiter may say about the user: what the profile has, nothing more. */
export function outreachFacts(profile: Pick<ProfileData, "basics" | "languages">): OutreachFacts {
  return {
    name: profile.basics.name.trim(),
    headline: profile.basics.headline.trim(),
    city: profile.basics.city.trim(),
    languages: profile.languages.map((language) => ({ name: language.name, level: languageLevelLabel(language.level) })),
  };
}
