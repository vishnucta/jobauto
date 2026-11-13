import { z } from "zod";

// The phone-screen prep pack (Phase 3, jobauto fork): for one application,
// the questions a German first call asks, with her answers in short German
// she can say and the English beside them, a salary line, the sentence for
// when German runs out, three short stories from her own roles, and
// questions to ask them. Kept on the application (Application.prep) and
// shared by the server, the Call prep tab and the connector.

const pair = z.object({ de: z.string(), en: z.string() });
export type Pair = z.output<typeof pair>;

export const callPrepSchema = z.object({
  /** "Erzählen Sie etwas über sich", "Warum diese Stelle?"…, each with her answer. */
  questions: z.array(z.object({ question: pair, answer: pair })),
  /** What to say when asked about salary; "[…]" where she has to fill in a figure. */
  salary: pair,
  /** Short stories from her roles for "Tell me about a time…", in English: the interview after the call is often in English. */
  stories: z.array(z.object({ title: z.string(), situation: z.string(), action: z.string(), result: z.string() })),
  /** Questions she can ask them at the end. */
  toAsk: z.array(pair),
  /** What the profile couldn't answer, e.g. "What is your notice period?". */
  gaps: z.array(z.string()),
  /** Statements in the answers that the profile, the posting and her facts don't back (fact guard). */
  unverified: z.array(z.string()).default([]),
});
export type CallPrep = z.output<typeof callPrepSchema>;

/** The stored pack, or null when there is none or it doesn't read. */
export function callPrepOf(value: unknown): CallPrep | null {
  const parsed = callPrepSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The sentence for when German runs out, practised until it comes without thinking. Always the same, so it's never left to the AI. */
export const FALLBACK: Pair = {
  de: "Entschuldigung, mein Deutsch ist noch auf A2-Niveau. Ich lerne jeden Tag weiter. Können wir bitte auf Englisch weitermachen?",
  en: "Sorry, my German is still at A2 level. I keep learning every day. Could we please continue in English?",
};

/** Asking them to say it again, slower: the second sentence worth knowing by heart. */
export const SAY_AGAIN: Pair = {
  de: "Könnten Sie das bitte noch einmal langsamer wiederholen?",
  en: "Could you please repeat that a little more slowly?",
};

/** The statuses on reaching which the pack is prepared, unless there is one. */
export const PREP_STATUSES = ["SCREENING", "INTERVIEW"] as const;

/** The background job's key, to find a pack being prepared after a reload. */
export const prepJobKey = (applicationId: string) => `call-prep:${applicationId}`;

/** Lower case, letters only, umlauts kept: words to compare a spoken answer with the written one. */
const words = (text: string) =>
  text
    .toLocaleLowerCase("de-DE")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * How much of the written answer the spoken one said, 0–100: the share of
 * its words heard, each counted as often as it's written. Not a grade, a
 * sign of how close the practice came.
 */
export function spokenMatch(written: string, spoken: string): number {
  const expected = words(written);
  if (expected.length === 0) return 0;
  const heard = new Map<string, number>();
  for (const word of words(spoken)) heard.set(word, (heard.get(word) ?? 0) + 1);
  let found = 0;
  for (const word of expected) {
    const left = heard.get(word) ?? 0;
    if (left > 0) {
      found += 1;
      heard.set(word, left - 1);
    }
  }
  return Math.round((found / expected.length) * 100);
}
