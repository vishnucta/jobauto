import type { LevelsProblem } from "@/lib/profiles";

// Scoring is off (jobauto fork). Since 1.15 nothing is scored against a
// profile until its levels are chosen (E24-3); levelsProblem in profiles.ts
// says which profiles wait, as scoring itself asks it. This turns that into
// the one notice Positions, the Agent screen, the dashboard and Settings
// show, so they always agree. Pure: scoring-off-data.ts gathers the problems.

/** What the notice says, where "Choose levels" goes and the profile "Guess with AI" guesses for. */
export type ScoringOff = {
  /** "Scoring is off: choose the levels your profile is for." */
  title: string;
  /** What waits until then. */
  body: string;
  /** For Settings' Scoring card: "Choose the levels your profile is for. Nothing is scored until you do." */
  reason: string;
  /** Profile → Jobs it's for, for the first profile waiting. */
  href: string;
  profileId: string;
};

/** The notice as a screen shows it: with "Guess with AI" only when Dossier's own AI model can guess. */
export type ScoringOffNotice = ScoringOff & { canGuess: boolean };

const quoted = (names: readonly string[]) => {
  const all = names.map((name) => `“${name}”`);
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
};

/**
 * Whether scoring is off, and the notice that says so: `waiting` are the
 * problems of the profiles a screen scores against whose levels aren't
 * chosen, `profiles` how many profiles there are in all. Null when none
 * waits. With one profile, or none of them chosen, it's off altogether;
 * otherwise only for those named.
 */
export function scoringOff(waiting: readonly (LevelsProblem | null)[], profiles: number): ScoringOff | null {
  const blocked = waiting.filter((problem): problem is LevelsProblem => problem !== null);
  const [first] = blocked;
  if (!first) return null;
  const one = blocked.length === 1;
  if (profiles <= 1 || blocked.length >= profiles) {
    const whose = profiles <= 1 ? "your profile is" : "your profiles are";
    return {
      title: `Scoring is off: choose the levels ${whose} for.`,
      body: "Until then no posting gets a score: Best fit can't sort, How you fit doesn't run, and the job agent and strong-match alerts wait.",
      reason: `Choose the levels ${whose} for. Nothing is scored until you do.`,
      href: first.href,
      profileId: first.profileId,
    };
  }
  // Some profiles have theirs: only these wait.
  const names = quoted(blocked.map((problem) => problem.name));
  return {
    title: `Scoring is off for ${names}: choose the levels ${one ? "it's" : "they're"} for.`,
    body: `Until then no posting is scored against ${one ? "it" : "them"}.`,
    reason: `Choose the levels ${names} ${one ? "is" : "are"} for. Nothing is scored against ${one ? "it" : "them"} until you do.`,
    href: first.href,
    profileId: first.profileId,
  };
}
