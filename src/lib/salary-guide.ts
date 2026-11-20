import { normalText } from "@/lib/job-search/search";

// The salary guide (jobauto fork): what the postings she has seen pay for
// jobs like this one, from the salaries they state, so her salary line in
// a letter or a form isn't a guess. Worked out in code from postings Dossier
// already keeps; nothing is looked up anywhere.

/** A yearly range in euros, from what a posting states. */
export type SalaryRange = { min: number; max: number };

const YEAR_MIN = 15_000;
const YEAR_MAX = 400_000;

/** "43.200" or "60,000" or "60k" as a number of euros. */
function amount(text: string): number | null {
  const thousands = /^(\d+(?:[.,]\d+)?)\s*(?:k|t€|tsd\.?|tausend)$/i.exec(text.trim());
  if (thousands) return Number(thousands[1].replace(",", ".")) * 1000;
  // A dot or comma followed by exactly three digits groups thousands; otherwise it's a decimal.
  const plain = text.trim().replace(/[.,](?=\d{3}(?:\D|$))/g, "").replace(",", ".");
  const value = Number(plain);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * A posting's salary as a yearly range in euros, or null when it gives none
 * in euros, gives an hourly or daily rate, or gives an amount no salary has.
 * Monthly amounts count twelve times.
 */
export function parseSalary(text: string): SalaryRange | null {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || !/€|\beur\b|\beuro/i.test(value)) return null;
  if (/stunde|hour|\bstd\b|\/\s*h\b|tag\b|tagessatz|\bday\b|daily/i.test(value)) return null;
  const monthly = /monat|month|\bmtl\b|\/\s*m\b/i.test(value);
  const numbers = [...value.matchAll(/\d[\d.,]*\s*(?:k|t€|tsd\.?|tausend)?(?![\d])/gi)].map((match) => amount(match[0])).filter((number): number is number => number !== null);
  if (numbers.length === 0) return null;
  const [low, high = low] = numbers;
  const scale = monthly ? 12 : 1;
  const range = { min: Math.min(low, high) * scale, max: Math.max(low, high) * scale };
  return range.min >= YEAR_MIN && range.max <= YEAR_MAX ? range : null;
}

/** Words of a title that say nothing about the kind of job. */
const GENERIC = new Set(
  "senior junior lead head of and und the der die das mwd mfd wmd fmd dmw in im fur for mit with team gmbh ag remote hybrid hamburg frankfurt berlin munchen germany deutschland teilzeit vollzeit full part time".split(" "),
);

/** The words of a title that say what the job is: "Regulatory Reporting Analyst (m/w/d)" → regulatory, reporting, analyst. */
export function titleWords(title: string): Set<string> {
  return new Set(
    normalText(title)
      .split(" ")
      .filter((word) => word.length > 2 && !GENERIC.has(word)),
  );
}

/** How alike two titles are: the share of the smaller one's words they have in common. */
function alike(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export type SalaryGuide = {
  /** The middle half of what alike postings pay, yearly, rounded to €1,000. */
  low: number;
  high: number;
  median: number;
  /** How many postings it's from. */
  postings: number;
  /** "jobs like this one", or "all the jobs you've looked at" when too few are alike. */
  basis: "alike" | "all";
};

/** At least this many postings before a guide says anything. */
export const MIN_POSTINGS = 3;

const round = (value: number) => Math.round(value / 1000) * 1000;
const quantile = (sorted: number[], q: number) => {
  const position = (sorted.length - 1) * q;
  const below = Math.floor(position);
  return sorted[below] + (sorted[Math.min(below + 1, sorted.length - 1)] - sorted[below]) * (position - below);
};

/**
 * The guide for a job titled `title`, from postings she has seen (each job
 * once): those with an alike title, or all of them when fewer than three
 * are alike. Null when fewer than three state a salary at all.
 */
export function salaryGuide(title: string, postings: readonly { title: string; salary: string }[]): SalaryGuide | null {
  const wanted = titleWords(title);
  const paid = postings.flatMap((posting) => {
    const range = parseSalary(posting.salary);
    return range ? [{ words: titleWords(posting.title), middle: (range.min + range.max) / 2 }] : [];
  });
  const alikeOnes = paid.filter((posting) => alike(wanted, posting.words) >= 0.5);
  const [used, basis] = alikeOnes.length >= MIN_POSTINGS ? [alikeOnes, "alike" as const] : [paid, "all" as const];
  if (used.length < MIN_POSTINGS) return null;
  const sorted = used.map((posting) => posting.middle).sort((a, b) => a - b);
  return { low: round(quantile(sorted, 0.25)), high: round(quantile(sorted, 0.75)), median: round(quantile(sorted, 0.5)), postings: used.length, basis };
}

/** "€58,000–€72,000 a year (middle €65,000), from 14 jobs like this one". */
export function describeGuide(guide: SalaryGuide): string {
  const euros = (value: number) => `€${value.toLocaleString("en-GB")}`;
  const range = guide.low === guide.high ? euros(guide.median) : `${euros(guide.low)}–${euros(guide.high)}`;
  return `${range} a year (middle ${euros(guide.median)}), from ${guide.postings} ${guide.basis === "alike" ? "jobs like this one" : "jobs you've looked at"}`;
}
