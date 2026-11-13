import { z } from "zod";

import { AiProvider, Creativity, DateFormat, PaperSize, Tone } from "@/generated/prisma/enums";
import { announcementFeedSchema } from "@/lib/announcements/contract";
import { applyAnswersSchema, DEFAULT_APPLY_ANSWERS } from "@/lib/apply/answers";
import { JOB_SOURCES, JSEARCH_HOSTS } from "@/lib/job-search/search";
import { DEFAULT_SECTION_LAYOUT, sectionLayoutSchema } from "@/lib/resume-sections";
import { setupGuideSchema } from "@/lib/setup-guide";
import { SCORERS } from "@/lib/scoring/scorers";
import { startupsRefreshSchema } from "@/lib/startups/types";
import { AGENT_MAX_SOURCE_REQUESTS_PER_DAY } from "@/lib/agent/limits";

/** Date styles for documents (SET-6), labelled with an example as in the prototype. */
export const DATE_FORMATS: readonly { value: DateFormat; label: string }[] = [
  { value: DateFormat.DAY_MONTH_YEAR, label: "27 September 2026" },
  { value: DateFormat.MONTH_DAY_YEAR, label: "September 27, 2026" },
  { value: DateFormat.NUMERIC, label: "27-09-2026" },
];

/**
 * Formats a calendar date in the chosen style, with month names in the
 * document's language. Uses the date's UTC day, so pass a date at UTC midnight.
 */
export function formatDocumentDate(date: Date, format: DateFormat, locale = "en-US"): string {
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  if (format === DateFormat.NUMERIC) {
    const month = date.getUTCMonth() + 1;
    return `${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}-${year}`;
  }
  const month = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(date);
  return format === DateFormat.DAY_MONTH_YEAR ? `${day} ${month} ${year}` : `${month} ${day}, ${year}`;
}

/**
 * How long a finished background job is kept (Settings → Your data). Its
 * input and result hold what an AI task was given and wrote: a posting,
 * a resume's text, drafts not yet in an application.
 */
export const JOB_RETENTION_OPTIONS: readonly { hours: number; label: string }[] = [
  { hours: 1, label: "1 hour" },
  { hours: 24, label: "24 hours" },
  { hours: 24 * 7, label: "7 days" },
  { hours: 24 * 30, label: "30 days" },
];
export const DEFAULT_JOB_RETENTION_HOURS = 24;
export const isJobRetention = (hours: number) => JOB_RETENTION_OPTIONS.some((option) => option.hours === hours);
/** "24 hours" */
export const jobRetentionLabel = (hours: number) =>
  JOB_RETENTION_OPTIONS.find((option) => option.hours === hours)?.label ?? `${hours} hours`;

/** Which documents New application writes (#367): many job sites ask for only one. */
export const DOCUMENTS_TO_WRITE = ["both", "resume", "letter"] as const;
export type DocumentsToWrite = (typeof DOCUMENTS_TO_WRITE)[number];
export const DOCUMENTS_TO_WRITE_LABELS: Record<DocumentsToWrite, string> = { both: "Resume and cover letter", resume: "Resume only", letter: "Cover letter only" };

// ─── Stored settings ─────────────────────────────────────────────────────────
// Settings are stored in the Setting table, one text row per key: enums by
// name, flags as "true"/"false", lists as JSON. A missing key, or a value that
// doesn't fit, reads as the default below; null means "not set".

export const DEFAULT_BASE_THEME = "editorial";

const flag = (fallback: boolean) => z.stringbool().catch(fallback);

/** A value stored as JSON. */
const json = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((value): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    })
    .pipe(schema);

/** A list stored as a JSON array of strings. */
const stringList = json(z.array(z.string()));

/**
 * One run of the job agent (E16), kept here rather than as its Job, which
 * the task-data sweep deletes: the source-request quota counts these.
 */
export const agentSearchRunSchema = z.object({
  searchId: z.string(),
  searchName: z.string(),
  found: z.number().int().min(0),
  fresh: z.number().int().min(0),
  error: z.string().nullable(),
});
export type AgentSearchRun = z.infer<typeof agentSearchRunSchema>;
export const agentRunSchema = z.object({
  at: z.iso.datetime(),
  manual: z.boolean(),
  /** What the run ended with, for the Agent screen; null while it runs. */
  message: z.string().nullable(),
  /** Slots reserved together before dispatch. Legacy runs consumed one slot. */
  sourceRequests: z.number().int().min(1).max(AGENT_MAX_SOURCE_REQUESTS_PER_DAY).optional(),
  /** Each reserved slot's timestamp, advanced immediately before dispatch. */
  sourceRequestAts: z.array(z.iso.datetime()).min(1).max(AGENT_MAX_SOURCE_REQUESTS_PER_DAY).optional(),
  searches: z.array(agentSearchRunSchema).optional(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;
/** How many runs are kept: more than a day's worth, for the limit and the screen. */
export const AGENT_RUNS_KEPT = 10;

export const settingsSchema = z.object({
  // AI provider (SET-1). Null means "not set in the app": fall back to the
  // DOSSIER_AI_* environment variables, then to the built-in defaults.
  provider: z.enum(AiProvider).nullable().catch(null),
  baseUrl: z.string().nullable().catch(null),
  model: z.string().nullable().catch(null),
  /** Encrypted with a key derived from DOSSIER_SECRET (E6-2); never sent to the client. */
  apiKeyEnc: z.string().nullable().catch(null),
  creativity: z.enum(Creativity).catch(Creativity.BALANCED),
  /** "Never invent experience" (SET-4). */
  strict: flag(true),
  /** "Show what changed" (SET-5). */
  showDiff: flag(true),
  paper: z.enum(PaperSize).catch(PaperSize.A4),
  dateFormat: z.enum(DateFormat).catch(DateFormat.DAY_MONTH_YEAR),
  defaultTone: z.enum(Tone).catch(Tone.WARM),
  /** Language for generated documents; null means "the posting's language" (SET-7). */
  docLanguage: z.string().nullable().catch(null),
  /** The base resume's language, for its headings and dates; null means English, with the direction read from the profile. */
  resumeLanguage: z.string().nullable().catch(null),
  /** Languages added with "Other language…", kept in the list. */
  customLanguages: stringList.catch([]),
  fileNamePattern: z.string().catch("{name} – {company} – {doc}"),
  includeRefs: flag(false),
  /** What New application writes unless chosen there (#367). */
  documentsToWrite: z.enum(DOCUMENTS_TO_WRITE).catch("both"),
  nightlyBackup: flag(true),
  /** Finished background jobs are deleted after this many hours (JOB_RETENTION_OPTIONS). */
  jobRetentionHours: z.coerce.number().refine(isJobRetention).catch(DEFAULT_JOB_RETENTION_HOURS),
  /** A theme's id. loadSettings() reads a deleted one as Editorial. */
  baseThemeId: z.string().catch(DEFAULT_BASE_THEME),
  /** The Applications screen as last left (LST-7): view, filter and sort, e.g. "-match". */
  applicationsView: z.enum(["board", "table"]).catch("board"),
  applicationsFilter: z.enum(["all", "active", "closed"]).catch("all"),
  applicationsSort: z.string().catch("updated"),
  /** The dashboard's period as last left (E9-8). */
  dashboardPeriod: z.enum(["30d", "90d", "all"]).catch("all"),
  /** Applications to send each week, Monday to Sunday (weekly-target.ts); 0 is no target. */
  weeklyTarget: z.coerce.number().int().min(0).max(50).catch(0),
  /** Days without news before "Worth a look" suggests a follow-up (E9-9). */
  quietDays: z.coerce.number().int().min(1).max(60).catch(7),
  /** Experience, projects and education: newest first by date, or the order set by hand (E4-9). */
  /** Skills (public issue 62): the most relevant first on tailored resumes, until the user sets their own order, which is then kept. */
  skillOrder: z.enum(["relevance", "manual"]).catch("relevance"),
  experienceOrder: z.enum(["date", "manual"]).catch("date"),
  projectOrder: z.enum(["date", "manual"]).catch("date"),
  educationOrder: z.enum(["date", "manual"]).catch("date"),
  /** Where the setup guide was left (E21); null until it's first opened. */
  setupGuide: json(setupGuideSchema).nullable().catch(null),
  /** The base resume's sections: their order and which are off (#297). */
  resumeSections: json(sectionLayoutSchema).catch(DEFAULT_SECTION_LAYOUT),
  /** "Fit to one page" on the base resume (public issue 69): spacing, then type, tightened until it fits. */
  fitBaseResume: flag(false),
  /** Why the last nightly backup failed; null once one works again (E10-7). */
  backupProblem: z.string().nullable().catch(null),
  // Job search (E14-4). Null means "not set in the app": DOSSIER_JOBS_SOURCE
  // decides. "OFF" is a choice. Each source keeps its own key, encrypted
  // like the AI key, so switching back and forth loses nothing.
  jobSource: z.enum([...JOB_SOURCES, "OFF"]).nullable().catch(null),
  jsearchKeyEnc: z.string().nullable().catch(null),
  /** Where the JSearch key is from: OpenWeb Ninja, or the RapidAPI marketplace. */
  jsearchHost: z.enum(JSEARCH_HOSTS).catch("openwebninja"),
  serpapiKeyEnc: z.string().nullable().catch(null),
  adzunaAppId: z.string().nullable().catch(null),
  adzunaKeyEnc: z.string().nullable().catch(null),
  joobleKeyEnc: z.string().nullable().catch(null),
  /** When "I understand" was ticked under the Bundesagentur für Arbeit's note (#223); its searches wait for it. */
  arbeitsagenturAcceptedAt: z.iso.datetime().nullable().catch(null),
  // Scoring (#274): what Score in Find jobs and the job agent score postings
  // with. Null means "not set in the app": DOSSIER_SCORER decides, else the
  // AI model. Jev's key is encrypted like the others, under its own key.
  scorer: z.enum(SCORERS).nullable().catch(null),
  typesafeKeyEnc: z.string().nullable().catch(null),
  // Job agent (E16): recurring searches, run once a day. Off until turned on.
  // It asks the source in Settings → Job search, with its key.
  agentEnabled: flag(false),
  /** The hour of the day it runs, in the user's time zone. */
  agentHour: z.coerce.number().int().min(0).max(23).catch(7),
  /** Postings scored below this stay out of the queue. */
  agentMinScore: z.coerce.number().int().min(0).max(100).catch(70),
  /** The most postings a run scores, and the most drafts it prepares on its own. */
  agentMaxScores: z.coerce.number().int().min(1).max(30).catch(15),
  agentMaxDrafts: z.coerce.number().int().min(0).max(10).catch(3),
  /** Whether a run prepares drafts for its best postings, or only scores them (off by default, #197). */
  agentAutoDraft: flag(false),
  /** The latest runs, newest first. They belong to the install: exports leave them out (INSTALL_SETTINGS). */
  agentRuns: json(z.array(agentRunSchema)).catch([]),
  // Phone alerts (alerts.ts): the ntfy topic strong new matches and new jobs
  // on careers pages go to; null while they're off. The topic is as good as
  // a password and belongs to the install, as does why the last alert
  // failed, so exports leave both out (INSTALL_SETTINGS).
  alertAddress: z.string().nullable().catch(null),
  alertProblem: z.string().nullable().catch(null),
  /** The job agent alerts about postings scored at least this. */
  alertMinScore: z.coerce.number().int().min(0).max(100).catch(80),
  /** The day, in the user's time zone, the careers pages were last all checked (careers/check.ts). The install's, so exports leave it out. */
  careersCheckedOn: z.string().nullable().catch(null),
  // Startups (#222): when the screen was last opened, since the daily refresh
  // only runs while it's in use, and what the last refresh found. They belong
  // to the install, not its data, so exports leave them out (INSTALL_SETTINGS).
  startupsViewedAt: z.iso.datetime().nullable().catch(null),
  startupsLastRefresh: json(startupsRefreshSchema).nullable().catch(null),
  /** "Check for updates daily" in Settings → About (update-check.ts). */
  updateCheck: flag(true),
  // The newest release the update check has seen, the UTC day it last
  // asked, and the release "Not now" hid the sidebar notice for. They belong
  // to the install, not its data, so exports leave them out (INSTALL_SETTINGS).
  latestVersion: z.string().nullable().catch(null),
  latestVersionUrl: z.string().nullable().catch(null),
  updateCheckDay: z.string().nullable().catch(null),
  updateDismissed: z.string().nullable().catch(null),
  // The backend's notices (announcements/check.ts): its last answer, and the
  // ones dismissed here. They belong to the install, not its data, so exports
  // leave them out (INSTALL_SETTINGS).
  announcementFeed: json(announcementFeedSchema).nullable().catch(null),
  announcementsDismissed: stringList.catch([]),
  // The apply assistant (Phase A, src/lib/apply): the standard answers
  // employers' forms ask for and the profile doesn't hold, and whether it
  // may press Send itself.
  applyAnswers: json(applyAnswersSchema).catch(DEFAULT_APPLY_ANSWERS),
  /**
   * The laptop's Chrome the browser window opens in, e.g. "http://100.101.102.103:9222",
   * when the app runs on a server without a screen; null opens it on the computer
   * the app runs on (browser-address.ts). It belongs to the install, so exports
   * leave it out (INSTALL_SETTINGS).
   */
  applyBrowserAddress: z.string().nullable().catch(null),
  // Gmail and Calendar (E15). Off until the Google account is connected.
  // The OAuth client, entered in Settings → Google. Null means "not set in the
  // app": DOSSIER_GOOGLE_CLIENT_ID and DOSSIER_GOOGLE_CLIENT_SECRET decide.
  googleClientId: z.string().nullable().catch(null),
  /** Encrypted like the API keys (GOOGLE_CLIENT_SECRET); never sent to the client. */
  googleClientSecretEnc: z.string().nullable().catch(null),
  /** Read replies from Gmail. */
  gmailRead: flag(true),
  /** Which mail the inbox check reads: only threads Dossier knows and company domains, or every new mail. */
  gmailScope: z.enum(["known", "all"]).catch("known"),
  /** Minutes between inbox checks. */
  gmailInterval: z.coerce.number().int().min(5).max(120).catch(10),
  /** Look in the calendar for free times when an employer asks to meet. */
  calendarAvailability: flag(true),
  /** Add agreed interviews to the calendar. */
  calendarEvents: flag(true),
  /** The calendar to read and write; "primary" is the account's own. */
  calendarId: z.string().catch("primary"),
  /** Working days, 1 = Monday … 7 = Sunday, as JSON. */
  workDays: json(z.array(z.number().int().min(1).max(7))).catch([1, 2, 3, 4, 5]),
  /** Working hours as "HH:MM". */
  workStart: z.string().regex(/^\d{2}:\d{2}$/).catch("09:00"),
  workEnd: z.string().regex(/^\d{2}:\d{2}$/).catch("17:00"),
  /** The time zone for free slots and interviews; null means the browser's. */
  workTimeZone: z.string().nullable().catch(null),
  /** Interview length and the gap kept around other meetings, in minutes. */
  slotMinutes: z.coerce.number().int().min(15).max(240).catch(45),
  bufferMinutes: z.coerce.number().int().min(0).max(120).catch(15),
  // The Claude connector (#221): when it was turned on, or Claude was last
  // disconnected; null while it's off, and then its addresses answer 404.
  // Every connector token carries it, so a new value signs Claude out. It
  // belongs to the install, so exports leave it out (INSTALL_SETTINGS).
  connectorEnabledAt: z.iso.datetime().nullable().catch(null),
  /** Other MCP apps' callback addresses, allowed like Claude's (#281). The install's too: an import must never add one. */
  connectorRedirects: stringList.catch([]),
  // The browser's time zone as it last told the server, for work done
  // without a request, such as the inbox check (time-zone.ts). It belongs
  // to the install, not its data, so exports leave it out (INSTALL_SETTINGS).
  browserTimeZone: z.string().nullable().catch(null),
});
export type SettingsData = z.output<typeof settingsSchema>;

/** The settings from Setting rows; keys it doesn't know are ignored. */
export function settingsFromRows(rows: readonly { key: string; value: string }[]): SettingsData {
  // Old keys, such as Resume length's pageLimit (removed with the trimmer, #234), are left out here.
  const values: Record<string, string> = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return settingsSchema.parse(values);
}

/** The text stored for a setting's value, or null for "not set", whose row is removed. */
export function settingValue(value: SettingsData[keyof SettingsData]): string | null {
  if (value === null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
