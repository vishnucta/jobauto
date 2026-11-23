import { holds, REPORTING_TERMS } from "@/lib/hidden-titles";
import { normalText } from "@/lib/job-search/search";
import { passes, type Coverage } from "@/lib/posting-coverage";

// In your field (jobauto fork, "Niche first"): which postings already in
// Positions are in her own field, told from her field's words alone, with no
// AI call. Her field is small and her German is A2, so her few applications
// should go where the title match carries her: a recruiter reads the title
// and the last two roles first. A word match can be wrong (an IT job that
// names the field, a law firm's "regulatory"), so the mark says it is one
// until the posting is scored, and every screen that counts them says to
// read the posting first. The words are the field's one list,
// REPORTING_TERMS (hidden-titles.ts): add a word there and it counts here.
// Shared with the browser: nothing here reads the database.

/** How a posting earned the mark: a field word in its title, or two different ones in its text. */
export type FieldMatch = { by: "title" | "text"; words: string[] };

/** The field's words a text names, each as whole words ("EMIR" not in "Emirates"), in the list's order and spelling. */
export function fieldWordsIn(text: string): string[] {
  const folded = normalText(text);
  return REPORTING_TERMS.filter((term) => holds(folded, normalText(term)));
}

/**
 * Whether a posting is in her field, by its words: one field word in the
 * title is enough; a posting that names the field only in its text needs two
 * different words there, since one alone is often a passing mention. Null
 * when it isn't.
 */
export function fieldMatch(posting: { title: string; description: string }): FieldMatch | null {
  const inTitle = fieldWordsIn(posting.title);
  if (inTitle.length > 0) return { by: "title", words: inTitle };
  const inText = fieldWordsIn(posting.description);
  return inText.length >= 2 ? { by: "text", words: inText } : null;
}

/** Scored, with requirements to count: a score from before coverage, or none, isn't. */
const scored = (coverage: Coverage) => coverage.total > 0;

/** A low fit: scored, and the profile covers less than half of what the posting asks for (the Covers filter's "at least half"). */
export const lowFit = (coverage: Coverage): boolean => scored(coverage) && !passes(coverage, "half");

/**
 * The mark as the screens say it: a word match until the posting is scored;
 * once it is, just "In your field", or with "low fit" when the profile
 * covers less than half of it.
 */
export function fieldLabel(coverage: Coverage): string {
  if (!scored(coverage)) return "In your field (word match)";
  return lowFit(coverage) ? "In your field · low fit" : "In your field";
}

/** Why it has the mark, for the posting's details: "Regulatory Reporting in the title". */
export function fieldReason(match: FieldMatch): string {
  const words = match.words.length === 1 ? match.words[0] : `${match.words.slice(0, -1).join(", ")} and ${match.words.at(-1)}`;
  return `${words} in ${match.by === "title" ? "the title" : "the text"}`;
}

/** An ad this old, or with no date, may be filled already. */
export const STILL_OPEN_DAYS = 30;
export const STILL_OPEN = "Check it is still open";

/** Whether to check that a posting is still open before writing to it: posted more than 30 days ago, or with no date. */
export function checkStillOpen(postedAt: string | Date | null, now: Date): boolean {
  if (!postedAt) return true;
  const posted = new Date(postedAt).getTime();
  return !Number.isFinite(posted) || now.getTime() - posted > STILL_OPEN_DAYS * 86_400_000;
}

/** Said wherever marked postings are counted or filtered: the mark is only a word match. */
export const FIELD_WARNING = "Word matches can be wrong, so read the posting before you apply.";

/** The dashboard's line: this week's marked postings and how many of them she applied to. */
export const fieldWeekLine = ({ found, applied }: { found: number; applied: number }) => `In your field this week: ${found} found by word match, ${applied} applied. ${FIELD_WARNING}`;

/** How many marked postings are scored on their own each day, unless Settings says otherwise; 0 is off. */
export const DEFAULT_FIELD_SCORES = 5;
export const FIELD_SCORE_CHOICES = [0, 1, 2, 3, 5, 8, 10, 15, 20] as const;
/** "New" for the daily scoring: found within this many days. */
export const FIELD_NEW_DAYS = 7;
