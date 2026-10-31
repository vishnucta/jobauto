// Applying on the employer's own page (the bewerbung fork's Phase A): the
// applicant tracking system (ATS) behind a posting's link, told from its
// address. German employers mostly use a handful of them, and each has
// its own habits: some need an account before the form shows, some are
// job boards whose "apply" leads on to the employer, and some are simple
// and stable enough that pressing Send for the user is reasonable.

export const ATS_IDS = [
  "personio",
  "softgarden",
  "successfactors",
  "workday",
  "greenhouse",
  "lever",
  "join",
  "onlyfy",
  "dvinci",
  "umantis",
  "rexx",
  "workable",
  "smartrecruiters",
  "teamtailor",
  "recruitee",
  "ashby",
  "bite",
  "concludis",
  "stepstone",
  "indeed",
  "linkedin",
  "xing",
  "arbeitsagentur",
  "unknown",
] as const;
export type AtsId = (typeof ATS_IDS)[number];

export type AtsInfo = {
  id: AtsId;
  label: string;
  /** The user needs an account on the site before the form shows; the browser keeps her logged in between runs. */
  account: boolean;
  /** Its forms are simple and stable enough that pressing Send for the user is reasonable, when she turns that on. */
  autoSubmit: boolean;
  /** A job board: its "apply" usually leads on to the employer's own page, or needs the board's account. */
  board: boolean;
};

const INFO: Record<AtsId, Omit<AtsInfo, "id">> = {
  personio: { label: "Personio", account: false, autoSubmit: true, board: false },
  softgarden: { label: "softgarden", account: false, autoSubmit: false, board: false },
  successfactors: { label: "SAP SuccessFactors", account: true, autoSubmit: false, board: false },
  workday: { label: "Workday", account: true, autoSubmit: false, board: false },
  greenhouse: { label: "Greenhouse", account: false, autoSubmit: true, board: false },
  lever: { label: "Lever", account: false, autoSubmit: true, board: false },
  join: { label: "JOIN", account: false, autoSubmit: true, board: false },
  onlyfy: { label: "onlyfy (XING)", account: false, autoSubmit: false, board: false },
  dvinci: { label: "d.vinci", account: false, autoSubmit: false, board: false },
  umantis: { label: "Haufe Umantis", account: true, autoSubmit: false, board: false },
  rexx: { label: "rexx systems", account: false, autoSubmit: false, board: false },
  workable: { label: "Workable", account: false, autoSubmit: false, board: false },
  smartrecruiters: { label: "SmartRecruiters", account: false, autoSubmit: false, board: false },
  teamtailor: { label: "Teamtailor", account: false, autoSubmit: true, board: false },
  recruitee: { label: "Recruitee", account: false, autoSubmit: true, board: false },
  ashby: { label: "Ashby", account: false, autoSubmit: true, board: false },
  bite: { label: "BITE", account: false, autoSubmit: false, board: false },
  concludis: { label: "concludis", account: false, autoSubmit: false, board: false },
  stepstone: { label: "StepStone", account: true, autoSubmit: false, board: true },
  indeed: { label: "Indeed", account: true, autoSubmit: false, board: true },
  linkedin: { label: "LinkedIn", account: true, autoSubmit: false, board: true },
  xing: { label: "XING", account: true, autoSubmit: false, board: true },
  arbeitsagentur: { label: "Bundesagentur für Arbeit", account: true, autoSubmit: false, board: true },
  unknown: { label: "the employer's website", account: false, autoSubmit: false, board: false },
};

/** Host patterns, matched against the link's host without "www.". */
const PATTERNS: readonly [RegExp, AtsId][] = [
  [/(^|\.)personio\.(de|com)$/, "personio"],
  [/(^|\.)softgarden\.(io|de)$/, "softgarden"],
  [/(^|\.)successfactors\.(eu|com)$|(^|\.)jobs\.sap\.com$/, "successfactors"],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)myworkday\.com$/, "workday"],
  [/(^|\.)greenhouse\.io$/, "greenhouse"],
  [/(^|\.)lever\.co$/, "lever"],
  [/(^|\.)join\.com$/, "join"],
  [/(^|\.)onlyfy\.(jobs|com)$|(^|\.)prescreen\.io$/, "onlyfy"],
  [/(^|\.)dvinci\.(de|com)$|(^|\.)d-vinci\.de$/, "dvinci"],
  [/(^|\.)umantis\.com$/, "umantis"],
  [/(^|\.)rexx-systems\.com$|(^|\.)rexx-recruitment\.com$/, "rexx"],
  [/(^|\.)workable\.com$/, "workable"],
  [/(^|\.)smartrecruiters\.com$/, "smartrecruiters"],
  [/(^|\.)teamtailor\.com$/, "teamtailor"],
  [/(^|\.)recruitee\.com$/, "recruitee"],
  [/(^|\.)ashbyhq\.com$/, "ashby"],
  [/(^|\.)b-ite\.(com|de)$/, "bite"],
  [/(^|\.)concludis\.de$/, "concludis"],
  [/(^|\.)stepstone\.(de|com|at)$/, "stepstone"],
  [/(^|\.)indeed\.(com|de)$/, "indeed"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)xing\.com$/, "xing"],
  [/(^|\.)arbeitsagentur\.de$/, "arbeitsagentur"],
];

export function atsInfo(id: AtsId): AtsInfo {
  return { id, ...INFO[id] };
}

/** The host of a link, without "www."; empty for something that isn't a web address. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The ATS behind a link, from its host; "unknown" means the employer's own site, or no link at all. */
export function detectAts(url: string): AtsInfo {
  const host = hostOf(url);
  if (!host) return atsInfo("unknown");
  const found = PATTERNS.find(([pattern]) => pattern.test(host));
  return atsInfo(found ? found[1] : "unknown");
}
