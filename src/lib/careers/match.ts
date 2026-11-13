import { normalText } from "@/lib/job-search/search";

// Which of a careers page's jobs to keep (jobauto fork): those whose title
// holds one of the employer's words and whose place is one of its places.
// A big employer lists hundreds of jobs; these keep the ones she'd apply to.

/** "Reporting, Meldewesen" as its parts. */
export const listOf = (text: string) =>
  text
    .split(/[,;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Short words whole: "EMIR" in "EMIR Reporting Analyst", not in "Emirates".
 * Longer ones anywhere, for German compounds: "Buchhalter" in "Finanzbuchhalter".
 */
const holds = (text: string, part: string) => (part.length < 5 ? ` ${text} `.includes(` ${part} `) : text.includes(part));

/**
 * Whether a job is one to keep. A job whose place the feed doesn't give is
 * kept, so it's checked by hand rather than missed; "Remote" among the
 * places also keeps remote jobs.
 */
export function matchesEmployer(posting: { title: string; place: string; remote: boolean | null }, { keywords, places }: { keywords: string; places: string }): boolean {
  const title = normalText(posting.title);
  const words = listOf(keywords).map(normalText).filter(Boolean);
  if (words.length > 0 && !words.some((word) => holds(title, word))) return false;
  const wanted = listOf(places).map(normalText).filter(Boolean);
  if (wanted.length === 0 || !posting.place) return true;
  const place = normalText(posting.place);
  return wanted.some((part) => holds(place, part) || (part === "remote" && posting.remote === true));
}
