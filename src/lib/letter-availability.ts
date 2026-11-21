// Salary and start date in the cover letter (jobauto fork). Many German
// postings ask for "Gehaltsvorstellung und frühestmöglicher Eintrittstermin",
// and an application without them is often set aside. The answers are the
// standard answers on the Apply tab (applyAnswersSchema), kept once and used
// by the letter and the apply assistant alike.

const ASKS_SALARY =
  /gehaltsvorstellung|gehaltswunsch|gehaltsangabe|gehaltsrahmen ihrer wahl|einkommensvorstellung|vorstellungen? (?:zu(?:m|r)|bez[uü]glich (?:des|der)) (?:gehalt|verg[uü]tung|einkommen)|verg[uü]tungsvorstellung|salary expectations?|expected salary|desired salary|salary requirements?/i;

const ASKS_START =
  /eintrittstermin|eintrittsdatum|eintrittszeitpunkt|starttermin|startdatum|m[oö]gliche[nrs]? (?:eintritt|start)|fr[uü]heste(?:n|r|s)? (?:m[oö]gliche[nr]? )?(?:eintritt|starttermin|beginn)|fr[uü]hestm[oö]glich\w*|verf[uü]gbarkeit|k[uü]ndigungsfrist|earliest (?:possible )?(?:start|starting date|availability)|(?:possible|desired|your) start(?:ing)? date|notice period|when (?:you )?(?:can|could) start/i;

/** What the posting asks the letter to say: salary expectations, the earliest start date, or both. */
export function postingAsks(text: string): { salary: boolean; start: boolean } {
  return { salary: ASKS_SALARY.test(text), start: ASKS_START.test(text) };
}

/** The standard answers the letter can use; empty ones are left out. */
export type AvailabilityAnswers = { salary: string; startDate: string; noticePeriod: string };

/** What the letter is to say, from the answers, for what the posting asks. */
export type LetterAvailability = { salary?: string; start?: string; notice?: string };

/**
 * For a posting and the standard answers: what goes into the letter, and what
 * the posting asks for that has no answer yet ("salary", "start"), for the
 * letter tab to point out.
 */
export function letterAvailability(posting: string, answers: AvailabilityAnswers): { say: LetterAvailability | null; missing: ("salary" | "start")[] } {
  const asks = postingAsks(posting);
  const salary = answers.salary.trim();
  const start = answers.startDate.trim();
  const notice = answers.noticePeriod.trim();
  const say: LetterAvailability = {
    ...(asks.salary && salary ? { salary } : {}),
    ...(asks.start && start ? { start } : {}),
    ...(asks.start && notice ? { notice } : {}),
  };
  const missing = [...(asks.salary && !salary ? (["salary"] as const) : []), ...(asks.start && !start && !notice ? (["start"] as const) : [])];
  return { say: Object.keys(say).length > 0 ? say : null, missing };
}

/** The answers as lines for the prompt and the fact guard: "Salary expectation: 58.000 € brutto/Jahr". */
export function availabilityLines(say: LetterAvailability): string[] {
  const start = say.start && (/^\d{4}-\d{2}-\d{2}$/.test(say.start) ? `${say.start} (a date: write it as the letter's language writes dates)` : say.start);
  return [say.salary && `Salary expectation: ${say.salary}`, start && `Earliest start: ${start}`, say.notice && `Notice period: ${say.notice}`].filter((line): line is string => Boolean(line));
}

/** "your salary expectation and earliest start date", for the letter tab's note. */
export function missingWords(missing: readonly ("salary" | "start")[]): string {
  const words = missing.map((item) => (item === "salary" ? "your salary expectation" : "your earliest start date"));
  return words.join(" and ");
}
