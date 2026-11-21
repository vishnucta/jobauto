import { normalText } from "@/lib/job-search/search";

// Hidden titles (jobauto fork): what employers call the jobs that ask for
// her skills, when it isn't what she searches for. Regulatory reporting is
// advertised as Trade Support, Middle Office, Meldewesen, Regulatory
// Operations and more; searching only her own title misses those. Read from
// the postings Dossier has already seen, so it learns from her market.

/** Words that say how senior a job is, or nothing about what it is. */
const NOISE = /\b(senior|junior|sr|jr|lead|leitung|principal|associate|trainee|werkstudent(?:in)?|praktikant(?:in)?|intern(?:ship)?|vollzeit|teilzeit|full[- ]?time|part[- ]?time|remote|hybrid)\b\.?/gi;

/**
 * The job a title names, without gender marks, seniority, place or extras:
 * "Senior Trade Support Analyst (m/w/d) – Hamburg" → "Trade Support Analyst".
 */
export function coreTitle(title: string): string {
  return title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .split(/\s[-–—|]\s|\s\/\s|,/)[0]
    .replace(/\b[mwdfx]\s*\/\s*[mwdfx](?:\s*\/\s*[mwdfx])?\b/gi, " ")
    .replace(/\*in\b|:in\b|\/-?in\b/gi, "")
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Engineering titles (jobauto fork): a data or analytics engineer asks for her tools, but isn't her job. */
const ENGINEERING = /\b(engineer(?:ing)?|developer|entwickler(?:in)?|ingenieur(?:in)?|programmer|programmierer(?:in)?|devops)\b/i;

/** Whether `text` holds `term` as words: "EMIR" in "EMIR-Meldungen", not in "Emirates". */
function holds(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

export type HiddenTitle = { title: string; employers: number };

/**
 * The titles, used by the most employers first, of postings that ask for at
 * least two of `terms` (her skills and her field's words), used by at least
 * two employers, that none of `searched` covers. Each employer counts once,
 * so one employer's own title posted five times isn't a title employers
 * use; postings without an employer count as one. Engineering titles are
 * left out (jobauto fork).
 */
export function hiddenTitles(
  postings: readonly { title: string; description: string; company: string }[],
  terms: readonly string[],
  searched: readonly string[],
  { limit = 8, min = 2 }: { limit?: number; min?: number } = {},
): HiddenTitle[] {
  const wanted = [...new Set(terms.map(normalText).filter((term) => term.length > 2))];
  const covered = searched.map(normalText).filter(Boolean);
  const counts = new Map<string, { title: string; employers: Set<string> }>();
  for (const posting of postings) {
    const text = normalText(`${posting.title} ${posting.description}`);
    if (wanted.filter((term) => holds(text, term)).length < 2) continue;
    const title = coreTitle(posting.title);
    const key = normalText(title);
    if (key.length < 4 || key.split(" ").length > 5 || ENGINEERING.test(title)) continue;
    if (covered.some((phrase) => ` ${key} `.includes(` ${phrase} `) || ` ${phrase} `.includes(` ${key} `))) continue;
    const entry = counts.get(key) ?? { title, employers: new Set<string>() };
    entry.employers.add(normalText(posting.company));
    counts.set(key, entry);
  }
  return [...counts.values()]
    .map(({ title, employers }) => ({ title, employers: employers.size }))
    .filter((entry) => entry.employers >= min)
    .sort((a, b) => b.employers - a.employers || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Her field's own words, added to her skills when the profile is in regulatory reporting. */
export const REPORTING_TERMS = ["EMIR", "MiFIR", "MiFID", "transaction reporting", "regulatory reporting", "Meldewesen", "COREP", "FINREP", "reconciliation", "Abstimmung", "client money", "trade reporting", "Aufsichtsrecht"];
export const REPORTING_PROFILE = /\b(emir|mifir|mifid|transaction reporting|regulatory reporting|meldewesen|corep|finrep)\b/i;
