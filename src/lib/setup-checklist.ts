// Start here (jobauto fork): the few things that make the app work for her
// rather than wait for her, on the dashboard until they're done. Each says
// what it buys and is one click from done. Nothing here is required; each
// one left undone is a way in she isn't using yet.

export type SetupFacts = {
  /** The job agent is on and has what it needs. */
  agentRunning: boolean;
  weeklyTarget: number;
  googleConnected: boolean;
  /** Agencies on Recruiters, and how many she wrote to. */
  agencies: number;
  agenciesWritten: number;
  /** The standard answers a German recruiter's doubts need, saved. */
  readinessAnswered: boolean;
  /** The application whose Apply tab holds the standard answers, if any. */
  answersApplicationId: string | null;
  networkImported: boolean;
  phoneAlerts: boolean;
  careersFollowed: number;
};

export type SetupStep = {
  id: "agent" | "target" | "google" | "agencies" | "answers" | "network" | "alerts" | "careers";
  title: string;
  why: string;
  done: boolean;
  /** Where it's done; the weekly target is set right on the card. */
  href: string | null;
  action: string;
};

/** The steps, in the order they pay off. */
export function setupSteps(facts: SetupFacts): SetupStep[] {
  const steps: SetupStep[] = [
    {
      id: "agent",
      title: "Let the job agent search every morning",
      why: "It finds and scores new postings while you sleep, and can write the drafts.",
      done: facts.agentRunning,
      href: "/settings?section=agent",
      action: "Set it up",
    },
    {
      id: "target",
      title: "Set a weekly target",
      why: "Five a week is a steady pace; the dashboard and your supporter's digest count towards it.",
      done: facts.weeklyTarget > 0,
      href: null,
      action: "Aim for 5 a week",
    },
    {
      id: "agencies",
      title: facts.agencies > 0 ? `Write to the ${facts.agencies} agencies on your list` : "Write to recruitment agencies",
      why: "Agencies pitch you to employers who never advertise. Your Kurzprofil and the messages are ready.",
      done: facts.agencies > 0 && facts.agenciesWritten >= facts.agencies,
      href: "/recruiters",
      action: "Open Recruiters",
    },
    {
      id: "answers",
      title: "Answer what German recruiters wonder about",
      why: "Your work permit, German course and degree recognition go into every letter, so the doubts are settled before they're raised.",
      done: facts.readinessAnswered,
      href: facts.answersApplicationId ? `/applications/${facts.answersApplicationId}?tab=apply` : null,
      action: "Open the standard answers",
    },
    {
      id: "google",
      title: "Connect Gmail",
      why: "Replies are matched to their applications on their own, so nothing waits unseen.",
      done: facts.googleConnected,
      href: "/settings?section=google",
      action: "Connect",
    },
    {
      id: "careers",
      title: "Follow employers' careers pages",
      why: "Their new jobs reach you days before the job boards have them.",
      done: facts.careersFollowed > 0,
      href: "/careers",
      action: "Choose employers",
    },
    {
      id: "network",
      title: "Import your LinkedIn connections",
      why: "Every posting at an employer where you know someone says so: a referral is the quickest way in.",
      done: facts.networkImported,
      href: "/recruiters",
      action: "Import",
    },
    {
      id: "alerts",
      title: "Get strong matches on your phone",
      why: "Apply the same day a good job appears, while few others have.",
      done: facts.phoneAlerts,
      href: "/settings?section=agent",
      action: "Turn on",
    },
  ];
  // The standard answers live on an application's Apply tab: with none yet, that step waits.
  return steps.filter((step) => step.id !== "answers" || step.done || step.href);
}
