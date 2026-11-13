import type { LanguageLevel } from "@/generated/prisma/enums";

// How much German a posting asks for (Phase 1, the German-level gate), read
// from its text without the AI: which language the ad is written in, and
// the sentence that names a German level. Compared with the profile's own
// German, it says whether the job is within reach. It only advises: the
// quoted sentence lets the user overrule it.

/** CEFR levels in order; NATIVE above C2. */
const RANKS: Record<LanguageLevel | "NONE", number> = { NONE: 0, A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, NATIVE: 7 };
type Level = keyof typeof RANKS;

/** The profile's German level; NONE when it lists no German. */
export type ProfileGerman = LanguageLevel | "NONE";

export type GermanNeed = {
  /** The language the ad is written in, when it's clear. */
  adLanguage: "German" | "English" | null;
  /** The German level the posting asks for; null when it asks for none. */
  level: Exclude<Level, "NONE" | "NATIVE"> | null;
  /** Whether the level is only implied by the ad being written in German. */
  implied: boolean;
  /** German is named only as a plus ("von Vorteil", "nice to have"). */
  optional: boolean;
  /** The posting says the team works in English. */
  englishWorkplace: boolean;
  /** The sentence it's read from, as written; empty when there's none. */
  evidence: string;
};

/** Whether the job is within reach of the profile's German: "out" ones are hidden until shown. */
export type GermanVerdict = "fits" | "stretch" | "out";

const GERMAN_WORDS = /\b(und|der|die|das|mit|für|wir|sie|ihre?|sind|eine?n?|bei|auf|zur|zum|werden|unsere?n?|kenntnisse|erfahrung|aufgaben)\b/gi;
const ENGLISH_WORDS = /\b(and|the|with|for|we|you|your|are|our|to|of|in|is|will|experience|responsibilities|team)\b/gi;

/** German as a language, not Germany, a company's name or German law. */
const MENTIONS_GERMAN =
  /\bdeutsch(?:kenntniss\w*|sprachig\w*|-|\s+(?:und|&|sowie|oder)\s+englisch)|\bDeutsch\b|\bdeutsch(?:e|en)\s+sprache|\bGerman\b(?!\s+(?:GAAP|tax|law|accounting|market|entit|compan|subsidiar|regulat|commercial|bank|office|operations|headquarter|clients?\b|customers?\b))/i;

/** Level wording, highest first; the first that matches a sentence about German wins. */
const LEVEL_WORDS: readonly [Exclude<Level, "NONE" | "NATIVE"> | "PLUS", RegExp][] = [
  ["PLUS", /von vorteil|wünschenswert|wuenschenswert|ein plus|nice[- ]to[- ]have|is a plus|an advantage|is beneficial|would be beneficial|desirable|preferred|not (?:required|necessary|mandatory)|nicht (?:erforderlich|notwendig|zwingend|vorausgesetzt)|keine deutschkenntnisse|no german (?:required|needed|necessary)/i],
  ["C2", /\bC2\b|muttersprach|mother tongue|native(?:[- ]level)?\s+(?:german|speaker)|german native/i],
  ["C1", /\bC1\b|verhandlungssicher|fließend|fliessend|sehr gute|exzellente|ausgezeichnete|perfekte|hervorragende|fluen(?:t|cy)|excellent|business[- ]fluent|strong (?:command|german)|full professional/i],
  ["B2", /\bB2\b|gute|sichere|solide|good|solid|professional working|working proficiency|in wort und schrift|written and spoken|spoken and written|deutschsprachig|german[- ]speaking/i],
  // Before B1, whose "kenntnisse" is in "Grundkenntnisse" too.
  ["A2", /\bA[12]\b|grundkenntnisse|basic|basis(?:kenntnisse|wissen)/i],
  ["B1", /\bB1\b|grundlegende|conversational|working knowledge|erforderlich|vorausgesetzt|required|must|zwingend|kenntnisse|proficien|speak german|knowledge of german/i],
];

const ENGLISH_WORKPLACE =
  /(?:arbeits|unternehmens|konzern|team)sprache\s+(?:ist\s+)?englisch|englisch\s+(?:ist\s+)?(?:unsere|die)\s+(?:arbeits|unternehmens|konzern)sprache|working language (?:is|will be) english|english is (?:our|the) (?:working|company|corporate|business|official) language|(?:company|corporate|business|official) language is english|english[- ]speaking (?:team|environment|company|workplace)/i;

/** Sentences and list items, cut at commas too so "fließend Englisch, Deutsch von Vorteil" reads as two. */
function clauses(text: string): string[] {
  return text
    .split(/[\n\r•·;]+|(?<=[.!?])\s+|,\s+/)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The ad's language, by counting everyday words; null for a short or mixed text. */
export function adLanguage(text: string): GermanNeed["adLanguage"] {
  const german = text.match(GERMAN_WORDS)?.length ?? 0;
  const english = text.match(ENGLISH_WORDS)?.length ?? 0;
  if (german + english < 12) return null;
  if (german >= english * 1.5) return "German";
  if (english >= german * 1.5) return "English";
  return null;
}

/** What German a posting asks for, from its title and text. */
export function germanNeed(text: string): GermanNeed {
  const language = adLanguage(text);
  const englishWorkplace = ENGLISH_WORKPLACE.test(text);
  let level: GermanNeed["level"] = null;
  let optional = false;
  let evidence = "";
  for (const clause of clauses(text)) {
    if (!MENTIONS_GERMAN.test(clause)) continue;
    const found = LEVEL_WORDS.find(([, words]) => words.test(clause))?.[0];
    if (!found) continue;
    if (found === "PLUS") {
      if (!level && !optional) evidence = clause;
      optional = true;
      continue;
    }
    if (!level || RANKS[found] > RANKS[level]) {
      level = found;
      evidence = clause;
    }
  }
  if (englishWorkplace && !level) evidence ||= text.match(ENGLISH_WORKPLACE)?.[0] ?? "";
  // An ad written in German that names no level still expects German at work.
  const implied = !level && !optional && !englishWorkplace && language === "German";
  return { adLanguage: language, level: implied ? "B2" : level, implied, optional: optional && !level, englishWorkplace, evidence: evidence.slice(0, 300) };
}

/** The profile's German, from its languages: "Deutsch" or "German"; NONE when it lists neither. */
export function profileGerman(languages: readonly { name: string; level: LanguageLevel }[]): ProfileGerman {
  return languages.find((language) => /^(german|deutsch)\b/i.test(language.name.trim()))?.level ?? "NONE";
}

/**
 * Whether the job is within reach: "fits" when the profile's German meets
 * what it asks or the team works in English, "stretch" one level short or
 * when the level is only implied, "out" two or more short.
 */
export function germanVerdict(need: GermanNeed, german: ProfileGerman): GermanVerdict {
  if (!need.level || need.englishWorkplace) return "fits";
  const gap = RANKS[need.level] - RANKS[german];
  if (gap <= 0) return "fits";
  if (gap === 1 || (need.implied && gap < 3)) return "stretch";
  return "out";
}

/** A short label for a badge, or "" when there's nothing to say. */
export function germanLabel(need: GermanNeed, verdict: GermanVerdict): string {
  if (need.englishWorkplace) return "English team";
  if (verdict === "fits") return need.adLanguage === "English" && !need.level ? "In English" : "";
  if (need.implied) return "Ad in German";
  return `German ${need.level}`;
}

/** One sentence for the badge's title and the posting's detail. */
export function germanExplanation(need: GermanNeed, verdict: GermanVerdict): string {
  if (need.englishWorkplace) return `The team works in English: “${need.evidence}”`;
  if (need.implied) return "The ad is written in German and names no level, so expect German at work, about B2.";
  if (need.level) return `${verdict === "out" ? "Needs more German than your profile has" : verdict === "stretch" ? "Asks for a bit more German than your profile has" : "Asks for German you have"}: “${need.evidence}”`;
  if (need.optional) return `German is only a plus: “${need.evidence}”`;
  return need.adLanguage === "English" ? "The ad is in English and asks for no German." : "";
}

/** The text a posting's German is read from: its title, then its description. */
export const textForGerman = (posting: { title: string; description: string }) => `${posting.title}\n${posting.description}`;

/** A posting's need and verdict together. */
export function germanFit(text: string, german: ProfileGerman) {
  const need = germanNeed(text);
  const verdict = germanVerdict(need, german);
  return { need, verdict, label: germanLabel(need, verdict), explanation: germanExplanation(need, verdict) };
}
export type GermanFit = ReturnType<typeof germanFit>;
