import { WIKI, type Instruction } from "./instructions";

// The setup guide's job search step (E21-3): what kind of jobs, then the
// source for it, with how to get its free key. The Bundesagentur für Arbeit
// isn't here: it's unofficial, and chosen in Settings with its note.

export type JobKind = "tech" | "any" | "none";

export const JOB_KINDS: readonly { value: JobKind; name: string; description: string }[] = [
  { value: "tech", name: "Mostly tech", description: "Software, design, data and other roles at tech companies. No key needed." },
  { value: "any", name: "Any kind of job", description: "Every field, from the big job sites. Needs a free key, which takes a few minutes to get." },
  { value: "none", name: "None for now", description: "You'll paste the postings you find yourself. Find jobs stays off until you choose a source in Settings." },
];

export type JobChoice = {
  source: "FREEHIRE" | "ADZUNA" | "JSEARCH";
  kind: Exclude<JobKind, "none">;
  name: string;
  about: string;
  cost: string;
  steps: readonly Instruction[];
};

export const JOB_CHOICES: readonly JobChoice[] = [
  {
    source: "FREEHIRE",
    kind: "tech",
    name: "FreeHire",
    about: "Postings read straight from companies' own career pages, mostly tech, in most countries, with their whole text.",
    cost: "Free for personal use, with no key.",
    steps: [{ text: "Press **Use FreeHire** below. That's all." }],
  },
  {
    source: "ADZUNA",
    kind: "any",
    name: "Adzuna",
    about: "Adzuna's own job index in 19 countries. It shares the start of each posting, and Dossier reads the rest from the posting's page.",
    cost: "A free key, with no card. Your account shows how many searches it allows.",
    steps: [
      {
        text: "Sign up as an Adzuna developer. The form asks for an organisation and a website: pick **Personal job search** as what you'll use it for, and enter a page of your own, such as your LinkedIn profile.",
        link: { href: "https://developer.adzuna.com/signup", label: "Adzuna's sign-up" },
      },
      { text: "Your account shows an application ID and a key. Copy both below." },
    ],
  },
  {
    source: "JSEARCH",
    kind: "any",
    name: "JSearch",
    about: "Postings from LinkedIn, Indeed, Glassdoor and company sites, through Google for Jobs, in most countries.",
    cost: "A free plan with a small number of searches each month, and no card. Its page shows how many.",
    steps: [
      { text: "Sign up on OpenWeb Ninja's developer portal and choose JSearch's free plan.", link: { href: "https://app.openwebninja.com", label: "OpenWeb Ninja" } },
      { text: "Copy your API key and paste it below." },
    ],
  },
];

export const JOB_SOURCES_HELP = `${WIKI}/Choosing-a-job-source`;
