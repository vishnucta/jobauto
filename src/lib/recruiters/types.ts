// Recruiters: the agencies and recruiters the user keeps track of, where each
// conversation stands, and the message to write next. Shared by the server and
// the screen, so nothing here reads the database. Dossier sends nothing: a
// message is drafted from the profile, and the user sends it from their own mail.

export const RECRUITER_STATUSES = ["NOT_CONTACTED", "CONTACTED", "REPLIED", "NOT_INTERESTED"] as const;
export type RecruiterStatusName = (typeof RECRUITER_STATUSES)[number];

export const STATUS_INFO: Record<RecruiterStatusName, { label: string; tone: "ok" | "warn" | "info" | "none" }> = {
  NOT_CONTACTED: { label: "Not contacted", tone: "none" },
  CONTACTED: { label: "Waiting", tone: "info" },
  REPLIED: { label: "Replied", tone: "ok" },
  NOT_INTERESTED: { label: "Not interested", tone: "none" },
};

/** Days after writing before a follow-up is due, and how long Snooze waits. */
export const FOLLOW_UP_DAYS = 7;
export const SNOOZE_DAYS = 3;

/** A recruiter as the screen gets it; dates are ISO strings. */
/** Who a contact is (jobauto fork): an agency or recruiter, a hiring manager, or someone who could refer her. */
export const CONTACT_KINDS = ["AGENCY", "HIRING_MANAGER", "REFERRAL"] as const;
export type ContactKindName = (typeof CONTACT_KINDS)[number];

export const CONTACT_KIND_INFO: Record<ContactKindName, { label: string; name: string; speciality: string; specialityHint: string }> = {
  AGENCY: { label: "Agency or recruiter", name: "Agency or recruiter", speciality: "Places people in", specialityHint: "e.g. Finance & accounting, Hamburg" },
  HIRING_MANAGER: { label: "Hiring manager", name: "Employer", speciality: "Their team or role", specialityHint: "e.g. Head of Regulatory Reporting" },
  REFERRAL: { label: "Someone who could refer you", name: "Employer", speciality: "Their team or role", specialityHint: "e.g. Finance Operations" },
};

export type RecruiterView = {
  id: string;
  kind: ContactKindName;
  name: string;
  contactName: string;
  email: string;
  website: string;
  speciality: string;
  /** How she knows them, e.g. "We worked together at AvaTrade". */
  relation: string;
  notes: string;
  source: string;
  status: RecruiterStatusName;
  contactedAt: string | null;
  followUpAt: string | null;
  createdAt: string;
  events: { id: string; text: string; at: string }[];
};

/** What the screen filters by: a status, or the ones whose follow-up is due. */
export type RecruiterFilter = "ALL" | "TO_CONTACT" | "WAITING" | "REPLIED" | "DUE";

/** Whether the user is waiting for an answer and the day to write again has come. */
export function followUpDue(recruiter: Pick<RecruiterView, "status" | "followUpAt">, now: Date): boolean {
  return recruiter.status === "CONTACTED" && recruiter.followUpAt !== null && Date.parse(recruiter.followUpAt) <= now.getTime();
}

export function matchesFilter(recruiter: RecruiterView, filter: RecruiterFilter, now: Date): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "TO_CONTACT":
      return recruiter.status === "NOT_CONTACTED";
    case "WAITING":
      return recruiter.status === "CONTACTED";
    case "REPLIED":
      return recruiter.status === "REPLIED";
    case "DUE":
      return followUpDue(recruiter, now);
  }
}

/** Due ones first, then those still to write to, then those being waited on, replies and the rest. */
export const listOrder = (recruiter: RecruiterView, now: Date) =>
  followUpDue(recruiter, now) ? 0 : ({ NOT_CONTACTED: 1, CONTACTED: 2, REPLIED: 3, NOT_INTERESTED: 4 } as const)[recruiter.status];

const DAY_MS = 86_400_000;
const whole = (from: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / DAY_MS));
const ago = (days: number) => (days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);

/** What happens next, in a line: "Contacted 9 days ago · follow-up due". */
export function nextStep(recruiter: RecruiterView, now: Date): string {
  switch (recruiter.status) {
    case "NOT_CONTACTED":
      return "Not contacted yet";
    case "NOT_INTERESTED":
      return "Not interested";
    case "REPLIED":
      return recruiter.contactedAt ? `Replied · you wrote ${ago(whole(recruiter.contactedAt, now))}` : "Replied";
    case "CONTACTED": {
      const wrote = recruiter.contactedAt ? `Contacted ${ago(whole(recruiter.contactedAt, now))}` : "Contacted";
      if (followUpDue(recruiter, now)) return `${wrote} · follow-up due`;
      const left = recruiter.followUpAt ? Math.ceil((Date.parse(recruiter.followUpAt) - now.getTime()) / DAY_MS) : 0;
      return recruiter.followUpAt ? `${wrote} · follow up in ${left} ${left === 1 ? "day" : "days"}` : wrote;
    }
  }
}

/** The buttons a status offers to move the conversation on. */
export function statusMoves(status: RecruiterStatusName): { to: RecruiterStatusName; label: string }[] {
  switch (status) {
    case "NOT_CONTACTED":
      return [
        { to: "CONTACTED", label: "I wrote to them" },
        { to: "NOT_INTERESTED", label: "Not interested" },
      ];
    case "CONTACTED":
      return [
        { to: "REPLIED", label: "They replied" },
        { to: "CONTACTED", label: "I followed up" },
        { to: "NOT_INTERESTED", label: "Not interested" },
      ];
    case "REPLIED":
      return [
        { to: "CONTACTED", label: "I wrote again" },
        { to: "NOT_INTERESTED", label: "Not interested" },
      ];
    case "NOT_INTERESTED":
      return [{ to: "NOT_CONTACTED", label: "Back to the list" }];
  }
}

/**
 * Agencies worth a message for someone in finance and regulatory reporting in
 * Hamburg. Each is one whose own pages say it works there or in Germany; the
 * website is the page the claim comes from. No address is listed: the user
 * adds the recruiter's own.
 */
export const STARTER_RECRUITERS: readonly { name: string; website: string; speciality: string; notes: string }[] = [
  {
    name: "Robert Walters",
    website: "https://www.robertwalters.de/en/contact-us/germany/hamburg.html",
    speciality: "Finance & accounting, Hamburg",
    notes: "Hamburg office at Gorch-Fock-Wall 1a, near the Alster. Works in English.",
  },
  {
    name: "Selby Jennings",
    website: "https://selbyjennings.com/en-de/contact-us",
    speciality: "Financial services, incl. regulatory reporting",
    notes: "Offices in Berlin and Frankfurt, and says it serves Hamburg. Has advertised regulatory reporting roles for Hamburg banks (COREP, FINREP).",
  },
  {
    name: "Hays",
    website: "https://www.hays.de/personalvermittlung/personaldienstleister/standorte/hamburg",
    speciality: "All fields, incl. banking and finance",
    notes: "Hamburg office at Ericusspitze 2-4. Ask which team covers regulatory reporting.",
  },
  {
    name: "Robert Half",
    website: "https://www.roberthalf.com/de/de/jobs/hamburg/finanzwesen",
    speciality: "Finance & accounting",
    notes: "Lists Hamburg finance roles, mostly senior and general. Candidates pay nothing.",
  },
];

/** Text as words, for comparing names: no accents or case, one space between words. */
export const foldName = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Where a recruiter on the list came from, as the screen says it; absent for one the user added. */
export const SOURCE_LABEL: Record<string, string> = {
  "starter list": "Suggested",
  "found in search": "Found in a search",
  "came with a job": "Came with a job",
};

/** Staffing and recruiting firms by name, spelled as they should appear on the list. */
const KNOWN_AGENCIES: { name: string; pattern: RegExp }[] = [
  { name: "Selby Jennings", pattern: /\bselby jennings\b/ },
  { name: "Phaidon International", pattern: /\bphaidon international\b/ },
  { name: "Michael Page", pattern: /\bmichael page\b/ },
  { name: "Page Personnel", pattern: /\bpage personnel\b/ },
  { name: "Robert Walters", pattern: /\brobert walters\b/ },
  { name: "Walters People", pattern: /\bwalters people\b/ },
  { name: "Robert Half", pattern: /\brobert half\b/ },
  { name: "Hays", pattern: /\bhays\b/ },
  { name: "Randstad", pattern: /\brandstad\b/ },
  { name: "Adecco", pattern: /\badecco\b/ },
  { name: "Brewer Morris", pattern: /\bbrewer morris\b/ },
  { name: "Morgan McKinley", pattern: /\bmorgan mckinley\b/ },
  { name: "Harvey Nash", pattern: /\bharvey nash\b/ },
  { name: "Experis", pattern: /\bexperis\b/ },
  { name: "Manpower", pattern: /\bmanpower\b/ },
  { name: "Gi Group", pattern: /\bgi group\b/ },
  { name: "Kelly Services", pattern: /\bkelly services\b/ },
  { name: "Amoria Bond", pattern: /\bamoria bond\b/ },
];

/** Words in a company's name that say it recruits for others. */
const RECRUITING_WORDS =
  /\b(recruitment|recruiting|recruiters?|personalberatung|personalvermittlung|personaldienstleister|personaldienstleistungen|executive search|headhunters?|staffing)\b/;

/**
 * The recruiter or agency a company is, or null when it looks like an
 * employer: a staffing firm the list knows by name, or one whose own name
 * says so ("Acme Recruitment", "Nord Personalberatung"). A posting's text is
 * left out on purpose: "for our client" would take many an employer for an
 * agency, and a wrong guess puts a stranger on the list.
 */
export function agencyOf(company: string): { name: string; key: string } | null {
  const folded = foldName(company);
  if (!folded) return null;
  const known = KNOWN_AGENCIES.find((agency) => agency.pattern.test(folded));
  if (known) return { name: known.name, key: foldName(known.name) };
  if (RECRUITING_WORDS.test(folded)) return { name: company.trim().replace(/\s+/g, " ").slice(0, 200), key: folded };
  return null;
}

/** Whether two names are the same agency: equal, or one is the other with more words ("Hays" and "Hays Germany"). */
export function sameAgency(a: string, b: string): boolean {
  const [x, y] = [foldName(a), foldName(b)];
  return x !== "" && y !== "" && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
}

/** The facts about the user a message may state: from the profile, never made up. */
export type OutreachFacts = {
  name: string;
  headline: string;
  city: string;
  languages: { name: string; level: string }[];
};

export type OutreachKind = "first" | "follow-up";

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

/**
 * The message to write: a first one, or a follow-up to the one the user
 * marked as sent. It says who she is and where, what she is looking for in
 * the recruiter's own field, and what languages she speaks, as her profile
 * has them. The user reads and edits it before sending.
 */
export function outreachDraft(
  recruiter: Pick<RecruiterView, "name" | "contactName" | "speciality" | "contactedAt"> & Partial<Pick<RecruiterView, "kind" | "relation">>,
  kind: OutreachKind,
  facts: OutreachFacts,
): { subject: string; body: string } {
  const greeting = recruiter.contactName.trim() ? `Hello ${recruiter.contactName.trim()},` : "Hello,";
  const who = [facts.headline.trim() || null, facts.city.trim() ? `based in ${facts.city.trim()}` : null].filter(Boolean).join(", ");
  const languages = facts.languages.map((language) => `${language.name} (${language.level})`);
  const field = recruiter.speciality.trim();
  const sign = facts.name.trim();
  const subject = clip(`Introduction: ${facts.headline.trim() || sign}`, 90);
  if (recruiter.kind === "HIRING_MANAGER" || recruiter.kind === "REFERRAL") return personDraft({ ...recruiter, kind: recruiter.kind, relation: recruiter.relation ?? "" }, kind, facts, { greeting, who, languages, sign });

  if (kind === "follow-up") {
    const when = recruiter.contactedAt
      ? ` on ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(recruiter.contactedAt))}`
      : "";
    return {
      subject: `Following up: ${subject.replace(/^Introduction: /, "")}`.slice(0, 100),
      body: [
        greeting,
        `I wrote to you${when} about roles${field ? ` in ${field.toLowerCase()}` : ""} and wanted to follow up. I am still looking, and I would be glad to hear whether a short call fits.`,
        "My resume is attached again.",
        ["Kind regards,", sign].filter(Boolean).join("\n"),
      ].join("\n\n"),
    };
  }
  return {
    subject,
    body: [
      greeting,
      `I am ${sign || "writing to you"}${who ? `, ${who}` : ""}. I am looking for my next role${field ? ` and saw that you place people in ${field.toLowerCase()}` : ""}.`,
      languages.length > 0 ? `My languages: ${languages.join(", ")}.` : "",
      "My resume is attached. I would be glad to hear whether a short call fits.",
      ["Kind regards,", sign].filter(Boolean).join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * The message to a person rather than an agency (jobauto fork): a hiring
 * manager, written to directly about their team, or someone she knows at an
 * employer, asked for a referral or a name. Referrals are the quickest way
 * into a team that works in English.
 */
function personDraft(
  person: Pick<RecruiterView, "name" | "contactName" | "speciality" | "contactedAt" | "relation"> & { kind: "HIRING_MANAGER" | "REFERRAL" },
  kind: OutreachKind,
  facts: OutreachFacts,
  { greeting, who, languages, sign }: { greeting: string; who: string; languages: string[]; sign: string },
): { subject: string; body: string } {
  const company = person.name.trim();
  const team = person.speciality.trim();
  const relation = person.relation.trim().replace(/[.!]+$/, "");
  const closing = ["Kind regards,", sign].filter(Boolean).join("\n");
  const referral = person.kind === "REFERRAL";
  const subject = clip(referral ? `${facts.headline.trim() || "My next role"}: could you point me the right way at ${company}?` : `${facts.headline.trim() || sign}, interested in ${team ? `your ${team.toLowerCase()} team` : company}`, 100);

  if (kind === "follow-up") {
    return {
      subject: `Following up: ${subject}`.slice(0, 100),
      body: [
        greeting,
        referral
          ? `I wanted to follow up on my message about ${company}. If a referral isn't possible, a name of someone I could write to would already help a lot.`
          : `I wanted to follow up on my message about ${team ? `your ${team.toLowerCase()} team` : `roles at ${company}`}. I am still very interested, and a short call at a time that suits you would be great.`,
        "My resume is attached again.",
        closing,
      ].join("\n\n"),
    };
  }
  return {
    subject,
    body: [
      referral ? greeting.replace(/^Hello/, "Hi") : greeting,
      referral
        ? `${relation ? `${relation}, and I hope you are well. ` : "I hope you are well. "}I am looking for my next role${who ? ` as ${who}` : ""}, and ${company} is one of the places I would most like to work.`
        : `I am ${sign || "writing to you"}${who ? `, ${who}` : ""}.${relation ? ` ${relation}.` : ""} I am writing to you directly because ${team ? `you lead ${team} at ${company}` : `of your team at ${company}`}, and I would like to bring my experience there.`,
      referral
        ? "Would you be open to referring me, or telling me who I should talk to? I am happy to send anything that makes it easy for you."
        : "Is there an opening in your team I should apply for, or would a short call fit in the next weeks?",
      languages.length > 0 ? `My languages: ${languages.join(", ")}.` : "",
      "My resume is attached.",
      closing,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/** A Gmail compose window with the message filled in, for the user to send. */
export function gmailLink(to: string, subject: string, body: string): string {
  const params = new URLSearchParams({ view: "cm", fs: "1", su: subject, body });
  if (to.trim()) params.set("to", to.trim());
  return `https://mail.google.com/mail/?${params.toString()}`;
}
