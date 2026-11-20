import { z } from "zod";

// Experiments (jobauto fork): she tests one change at a time, such as
// letters in English or in German, or one headline against another. While
// an experiment runs, each new application gets version A or B, whichever
// has fewer so far; she writes it that way, and What's working compares how
// often each version moved on. With so few applications it can only lean
// one way, and says so.

export const experimentSchema = z.object({
  /** What's being tested, e.g. "Letter language". */
  name: z.string().trim().min(1, "Name what you're testing.").max(80),
  /** The two versions, e.g. "English letter" and "German letter". */
  a: z.string().trim().min(1, "Say what version A is.").max(120),
  b: z.string().trim().min(1, "Say what version B is.").max(120),
  startedAt: z.iso.datetime(),
});
export type Experiment = z.output<typeof experimentSchema>;

export type Arm = "A" | "B";

/** The version a new application gets: the one with fewer so far, A on a tie. */
export function nextArm(counts: { A: number; B: number }): Arm {
  return counts.B < counts.A ? "B" : "A";
}

/** "B: German letter" for a version of the experiment. */
export const armLabel = (experiment: Pick<Experiment, "a" | "b">, arm: Arm) => `${arm}: ${arm === "A" ? experiment.a : experiment.b}`;

/** Each version needs this many sent before the comparison says anything. */
export const ENOUGH_PER_ARM = 5;

export type ArmResult = { arm: Arm; label: string; sent: number; replies: number };

/**
 * What the experiment shows so far, in words: too early, a lean one way
 * ("leaning towards"), or no difference. Never proof: the numbers are small.
 */
export function verdict(results: readonly ArmResult[]): string {
  const [a, b] = results;
  if (!a || !b || a.sent < ENOUGH_PER_ARM || b.sent < ENOUGH_PER_ARM) {
    const short = results.filter((result) => result.sent < ENOUGH_PER_ARM).map((result) => `${ENOUGH_PER_ARM - result.sent} more of ${result.arm}`);
    return `Too early to tell: send ${short.join(" and ")}.`;
  }
  const rate = (result: ArmResult) => result.replies / result.sent;
  const gap = rate(a) - rate(b);
  if (Math.abs(gap) < 0.1) return "No clear difference yet: both get answers about as often.";
  const better = gap > 0 ? a : b;
  return `Leaning towards ${better.label}, from small numbers: keep going before you decide.`;
}
