import { experienceMonths, type ProfileData } from "@/lib/profile";
import { DACH } from "@/lib/startups/place";

import { countryCodeFor } from "./countries";
import { GERMAN_WORDS } from "./glossary";
import { normalText } from "./search";

// Suggested search words, from the profile: what to type into Find jobs.
// Worked out from the profile every time it changes, so they are never out of
// date and nothing is stored. Short on purpose: a source treats every word as
// a requirement, so a whole headline finds nothing where "Financial Analyst"
// finds hundreds. No AI and nothing leaves the server.

export type SearchWord = { text: string; language: "en" | "de"; why: string };
export type SearchWordGroup = { title: string; words: SearchWord[] };
export type SearchWords = {
  groups: SearchWordGroup[];
  /** Whether German words are offered: for a profile in Germany, Austria or Switzerland. */
  german: boolean;
  /** The years of experience the roles add up to, when that is enough for "Senior" to be offered; else null. Not something the profile says. */
  seniorYears: number | null;
};

/** The most words in a suggestion. */
export const MAX_WORDS = 3;
/** Months of experience from which "Senior" is offered with the latest role: about eight years. */
const SENIOR_MONTHS = 96;
const MAX_SKILLS = 6;

const ENTRY_LEVEL = /\b(intern|internship|trainee|assistant|apprentice|student|volunteer|werkstudent|praktikant|azubi|article)\b/i;
const HAS_LEVEL = /^(senior|sr|junior|jr|lead|head|principal|chief|staff|manager|director)\b/i;

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const short = (text: string) => text.trim() !== "" && wordCount(text) <= MAX_WORDS;

type Role = ProfileData["experience"][number];
const monthOf = (year: number | null, month: number | null) => (year === null ? -1 : year * 12 + (month ?? 1));

/** Roles, the current one first, then the one that ended last. */
const newestFirst = (experience: readonly Role[]) =>
  experience
    .filter((entry) => entry.role.trim())
    .toSorted(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        monthOf(b.endYear, b.endMonth) - monthOf(a.endYear, a.endMonth) ||
        monthOf(b.startYear, b.startMonth) - monthOf(a.startYear, a.startMonth),
    );

/**
 * What a headline names after its first part, in the order it does, and
 * whether it is a detail in brackets: "Financial Analyst — Regulatory
 * Reporting (EMIR Refit, MiFIR) & Reconciliation" gives Regulatory Reporting,
 * EMIR Refit and MiFIR (details) and Reconciliation.
 */
function headlineSpecialties(headline: string): { text: string; detail: boolean }[] {
  const parts: { text: string; detail: boolean }[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const text = current.trim();
    if (text) parts.push({ text, detail: depth > 0 });
    current = "";
  };
  for (const char of headline.replace(/\s[—–-]\s/g, ",").replace(/\band\b/gi, ",")) {
    if (char === "(" || char === "[") {
      flush();
      depth += 1;
    } else if (char === ")" || char === "]") {
      flush();
      depth = Math.max(0, depth - 1);
    } else if (",;/&".includes(char)) flush();
    else current += char;
  }
  flush();
  // One part is just a title, which the roles already give.
  return parts.length > 1 ? parts.slice(1) : [];
}

/** A skill as search words: "COREP / IFR" is two, and a name that is too long is none. */
const skillParts = (name: string) => (name.includes("/") ? name.split("/") : [name]).map((part) => part.trim()).filter(short);

/** An acronym that leads a longer name is searched alone too: "EMIR Refit" gives "EMIR". */
function withAcronym(name: string): string[] {
  const first = name.split(/\s+/)[0] ?? "";
  return wordCount(name) > 1 && /^[A-Z]{3,}$/.test(first) ? [name, first] : [name];
}

/** The German for each English word that has one in the glossary, apart from those that read the same. */
function germanFor(words: SearchWord[]): SearchWord[] {
  return words.flatMap((word) => {
    const german = GERMAN_WORDS[normalText(word.text)];
    return german && normalText(german) !== normalText(word.text) ? [{ text: german, language: "de" as const, why: `German for ${word.text}` }] : [];
  });
}

/** Keeps the first of each word, by how it reads. */
function unique(words: SearchWord[], seen = new Set<string>()): SearchWord[] {
  return words.filter((word) => {
    const key = normalText(word.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function searchWords(profile: Pick<ProfileData, "basics" | "skills" | "experience">, today: Date, { senior: withSenior = true }: { senior?: boolean } = {}): SearchWords {
  const german = DACH.includes(countryCodeFor(profile.basics.country));
  const months = experienceMonths(profile, today);
  const years = Math.floor(months / 12);
  const seen = new Set<string>();

  // Titles: her roles, newest first, with "Senior" when she has the years, and
  // what her headline names a person does with the latest role's noun.
  const roles = unique(
    newestFirst(profile.experience)
      .filter((entry) => !ENTRY_LEVEL.test(entry.role) && short(entry.role))
      .map((entry, index) => ({ text: entry.role.trim(), language: "en" as const, why: index === 0 ? "Your latest role" : "A past role" })),
  ).slice(0, 3);
  const latest = roles[0]?.text ?? "";
  const specialties = headlineSpecialties(profile.basics.headline).filter(({ text }) => short(text));
  const noun = wordCount(latest) >= 2 ? (latest.split(/\s+/).at(-1) ?? "") : "";
  const seniorOffered = Boolean(latest) && months >= SENIOR_MONTHS && !HAS_LEVEL.test(latest) && short(`Senior ${latest}`);
  const senior: SearchWord[] = seniorOffered && withSenior ? [{ text: `Senior ${latest}`, language: "en", why: `${years} years of experience` }] : [];
  const composed: SearchWord[] = noun
    ? specialties
        .filter(({ text, detail }) => !detail && !normalText(text).endsWith(normalText(noun)) && short(`${text} ${noun}`))
        .slice(0, 2)
        .map(({ text }) => ({ text: `${text} ${noun}`, language: "en" as const, why: "Your headline and your role" }))
    : [];
  const titles = unique([...roles.slice(0, 1), ...senior, ...composed, ...roles.slice(1)], seen);
  const titleGroup = [...titles, ...unique(germanFor(titles.filter((word) => word.language === "en")), seen)];

  // Specialties: what the headline names.
  const specialtyWords = unique(
    specialties.flatMap(({ text }) => withAcronym(text)).map((text) => ({ text, language: "en" as const, why: "Your headline" })),
    seen,
  );
  const specialtyGroup = [...specialtyWords, ...unique(germanFor(specialtyWords), seen)];

  // Skills: those used in the most roles first.
  const used = new Map<string, number>();
  for (const entry of profile.experience) for (const id of new Set(entry.skillIds)) used.set(id, (used.get(id) ?? 0) + 1);
  const ranked = profile.skills.map((skill, index) => ({ skill, index, roles: used.get(skill.id) ?? 0 })).toSorted((a, b) => b.roles - a.roles || a.index - b.index);
  const skillWords = unique(
    ranked.flatMap(({ skill, roles: count }) =>
      skillParts(skill.name).map((text) => ({ text, language: "en" as const, why: count > 0 ? `Used in ${count} ${count === 1 ? "role" : "roles"}` : "In your skills" })),
    ),
    seen,
  ).slice(0, MAX_SKILLS);
  const skillGroup = [...skillWords, ...unique(germanFor(skillWords), seen)];

  const groups = [
    { title: "Job titles", words: titleGroup },
    { title: "Specialties", words: specialtyGroup },
    { title: "From your skills", words: skillGroup },
  ]
    .map((group) => ({ ...group, words: german ? group.words : group.words.filter((word) => word.language === "en") }))
    .filter((group) => group.words.length > 0);
  return { groups, german, seniorYears: seniorOffered ? years : null };
}

/**
 * A few words for Find jobs' own row: the best titles and specialties, and a
 * German one or two for a profile in the German-speaking countries.
 */
export function searchChips({ groups, german }: Pick<SearchWords, "groups" | "german">, limit = 6): string[] {
  const pick = (title: string, language: "en" | "de", count: number) =>
    (groups.find((group) => group.title === title)?.words ?? []).filter((word) => word.language === language).slice(0, count).map((word) => word.text);
  const chips = [...pick("Job titles", "en", 2), ...pick("Specialties", "en", 2)];
  if (german) chips.push(...pick("Specialties", "de", 1), ...pick("Job titles", "de", 1));
  const fill = (groups.find((group) => group.title === "From your skills")?.words ?? []).filter((word) => word.language === "en").map((word) => word.text);
  return [...new Set([...chips, ...fill])].slice(0, limit);
}
