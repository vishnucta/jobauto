import "server-only";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isAiUsable, loadAiSettingsView, PROVIDER_DEFAULTS } from "@/lib/ai/config";
import { providerOption } from "@/lib/ai/provider-options";
import { lastNightlyBackup } from "@/lib/backup-schedule";
import { buildExport, exportFileName } from "@/lib/data-export";
import { DOCUMENT_LANGUAGES } from "@/lib/document-language";
import { FILE_NAME_TOKENS } from "@/lib/file-name";
import { googleConnection } from "@/lib/google/account";
import { JobSearchError } from "@/lib/job-search";
import { credentialsFor, jobSearchView, loadJobSearchConfig, type JobSearchConfig } from "@/lib/job-search/config";
import { prisma } from "@/lib/prisma";
import { UPGRADE_GUIDE_URL } from "@/lib/releases";
import { JOB_RETENTION_OPTIONS } from "@/lib/settings";
import {
  aiChoiceSchema,
  availableAiModels,
  chooseJobSource,
  jobSearchDetailsSchema,
  jobSourceChoiceSchema,
  pickDocumentLanguage,
  saveAiChoice,
  saveJobSourceDetails,
  settingChoicesSchema,
  startPdfZip,
  testAiProvider,
  testJobSourceConnection,
  type AiChoice,
  type SettingChoices,
} from "@/lib/settings-changes";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { copyTheme, createTheme, deleteCustomTheme, makeBaseTheme, updateCustomTheme } from "@/lib/theme-changes";
import { loadTheme, loadThemes, loadThemeUsage } from "@/lib/theme-data";
import { parseThemeFile, themeFieldsSchema, type ThemeFields } from "@/lib/theme-file";
import type { ThemeData } from "@/lib/themes";
import { availableUpdate, checkForUpdate } from "@/lib/update-check";
import { appVersion } from "@/lib/version";

import { failure, started, text, type ToolContext } from "../kit";

// Themes, settings without secrets, and exports (jobauto fork): what the
// resume screen's themes and Settings do, through the same functions
// (src/lib/theme-changes.ts, src/lib/settings-changes.ts). Keys stay in
// Settings: no tool takes one or gives one back, and get_settings only says
// whether one is saved. Moving the AI to another server, which its key and
// everything it reads would go to, deleting everything, importing an export,
// the connector itself and the Bundesagentur für Arbeit's "I understand"
// stay on the screen.

const THEME_GONE = "There's no theme with that id. list_themes shows them all.";
const BUILT_IN = "Built-in themes can't be changed. Give its id as based_on to make a new theme from it.";

/** An object without its undefined fields, so spreading it only changes what's given. */
const given = <T extends object>(fields: T): Partial<T> => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

/** Text as JSON, or null when it isn't any (parseThemeFile then says it isn't a theme file). */
function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** "48 KB", "1.2 MB" */
const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * The largest export handed over as a file: about 22,000 tokens, under the
 * 25,000 Claude Code takes from a tool by default. A bigger one, as most
 * with a profile photo are, is downloaded with Export in Settings.
 */
const EXPORT_MAX_BYTES = 80 * 1024;

// ─── Themes ──────────────────────────────────────────────────────────────────

/** A theme's look, by the names the tools use for the theme builder's fields. */
const lookOf = (theme: ThemeFields) => ({
  head_font: theme.headFont,
  body_font: theme.bodyFont,
  accent: theme.accent,
  layout: theme.layout,
  align: theme.align,
  heading_style: theme.headingStyle,
  density: theme.density,
  header_style: theme.headerStyle,
  sidebar_style: theme.sidebarStyle,
  date_style: theme.dateStyle,
  photo_shape: theme.photoShape,
  photo_position: theme.photoPosition,
});

const field = themeFieldsSchema.shape;

/** The theme builder's fields as save_theme takes them, checked as the builder's are; each one left out stays as it is. */
const themeLook = {
  name: field.name.optional().describe("Up to 60 characters"),
  head_font: field.headFont.optional(),
  body_font: field.bodyFont.optional(),
  accent: field.accent.optional().describe("A color like #1f6f5c; dark ones read best as text"),
  layout: field.layout.optional(),
  align: field.align.optional().describe("The header's; sidebar layouts always align it left"),
  heading_style: field.headingStyle.optional().describe("How section titles look"),
  density: field.density.optional().describe("Spacing"),
  header_style: field.headerStyle.optional(),
  sidebar_style: field.sidebarStyle.optional().describe("For sidebar layouts"),
  date_style: field.dateStyle.optional(),
  photo_shape: field.photoShape.optional(),
  photo_position: field.photoPosition.optional().describe("SIDEBAR only in sidebar layouts"),
};
type LookInput = { [Name in keyof typeof themeLook]?: z.output<(typeof themeLook)[Name]> };

/** The fields given, as a theme is saved with them. */
const changesFrom = (look: LookInput): Partial<ThemeFields> =>
  given({
    name: look.name,
    headFont: look.head_font,
    bodyFont: look.body_font,
    accent: look.accent,
    layout: look.layout,
    align: look.align,
    headingStyle: look.heading_style,
    density: look.density,
    headerStyle: look.header_style,
    sidebarStyle: look.sidebar_style,
    dateStyle: look.date_style,
    photoShape: look.photo_shape,
    photoPosition: look.photo_position,
  });

// ─── Settings ────────────────────────────────────────────────────────────────

/** What the chosen job source still needs before it can be searched, in plain words; undefined when nothing. */
function jobSourceProblem(config: JobSearchConfig): string | undefined {
  if (!config.source) return undefined;
  try {
    credentialsFor(config, config.source);
    return undefined;
  } catch (error) {
    if (error instanceof JobSearchError) return error.message;
    throw error;
  }
}

/**
 * The settings by Settings' sections, with update_settings' names for what
 * it changes. Keys only by their state: none, set, unreadable (enter it
 * again) or env (from the server's environment). The connected Google
 * account's address stays out like other contact details.
 */
async function settingsView() {
  const [settings, ai, aiReady, jobSearch, google, lastBackup] = await Promise.all([
    loadSettings(),
    loadAiSettingsView(),
    isAiUsable(),
    loadJobSearchConfig(),
    googleConnection(),
    lastNightlyBackup(),
  ]);
  const jobs = jobSearchView(jobSearch);
  return {
    ai: {
      ai_provider: ai.provider,
      provider_name: providerOption(ai.provider).name,
      ai_address: ai.baseUrl,
      ai_model: ai.model || null,
      api_key: ai.keyState,
      ready: aiReady,
      creativity: settings.creativity,
      never_invent_experience: settings.strict,
      show_what_changed: settings.showDiff,
    },
    job_search: {
      job_source: jobs.source,
      problem: jobSourceProblem(jobSearch),
      jsearch_host: jobs.jsearch.host,
      jsearch_key: jobs.jsearch.keyState,
      serpapi_key: jobs.serpapi.keyState,
      adzuna_app_id: jobs.adzuna.appId || null,
      adzuna_key: jobs.adzuna.keyState,
      arbeitsagentur: { offered: jobs.arbeitsagentur.offered, understood: jobs.arbeitsagentur.acceptedAt !== null },
    },
    documents: {
      paper: settings.paper,
      date_format: settings.dateFormat,
      default_tone: settings.defaultTone,
      document_language: settings.docLanguage,
      resume_language: settings.resumeLanguage ?? "English",
      languages: [...DOCUMENT_LANGUAGES.map((language) => language.name), ...settings.customLanguages],
      file_name_pattern: settings.fileNamePattern,
      include_references: settings.includeRefs,
      page_limit: settings.pageLimit,
    },
    your_data: {
      nightly_backup: settings.nightlyBackup,
      last_backup: lastBackup?.toISOString() ?? null,
      backup_problem: settings.backupProblem,
      keep_task_data_hours: settings.jobRetentionHours,
    },
    // As update_google_settings names and shows them (tools/inbox.ts).
    google: {
      status: google.status,
      ...(google.status === "connected"
        ? {
            google_allows: { sending: google.canSend, reading: google.canRead, calendar: google.canUseCalendar },
            last_inbox_check: google.lastSyncAt?.toISOString(),
            inbox_problem: google.syncProblem ?? undefined,
          }
        : {}),
      gmail_read: settings.gmailRead,
      gmail_scope: settings.gmailScope,
      gmail_interval: settings.gmailInterval,
      calendar_availability: settings.calendarAvailability,
      calendar_events: settings.calendarEvents,
      calendar_id: settings.calendarId,
      work_days: settings.workDays,
      work_start: settings.workStart,
      work_end: settings.workEnd,
      work_time_zone: settings.workTimeZone ?? "",
      slot_minutes: settings.slotMinutes,
      buffer_minutes: settings.bufferMinutes,
    },
    about: {
      version: appVersion,
      check_for_updates_daily: settings.updateCheck,
      newer_version: availableUpdate(settings),
    },
  };
}

/** Where each setting update_settings changes is: its section in get_settings, and in Settings (?section=). */
const SECTIONS = [
  { name: "ai", id: "ai", fields: ["ai_provider", "ai_address", "ai_model", "creativity", "never_invent_experience", "show_what_changed"] },
  { name: "job_search", id: "jobs", fields: ["job_source", "jsearch_host", "adzuna_app_id"] },
  { name: "documents", id: "documents", fields: ["paper", "date_format", "default_tone", "document_language", "resume_language", "file_name_pattern", "include_references", "page_limit"] },
  { name: "your_data", id: "data", fields: ["nightly_backup", "keep_task_data_hours"] },
  { name: "about", id: "about", fields: ["check_for_updates_daily"] },
] as const;

/** update_settings' fields for the AI provider, saved together as Settings saves them. */
const AI_FIELDS = ["ai_provider", "ai_address", "ai_model"];

const ANOTHER_SERVER = "Only the user can point the AI at another server, in Settings → AI provider: the API key and everything the AI reads go wherever it points.";

/** An address's scheme, host and port; null when it isn't a web address. */
function serverOf(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The provider, address and model update_settings saves, as Settings saves
 * them together, or "another-server" when the address would point elsewhere.
 * The saved key or DOSSIER_AI_KEY, and everything the AI reads, go to that
 * server, so only the user moves it, typing it in Settings: here only the
 * path on the same server changes, and another provider starts from its
 * card's address, as picking the card does.
 */
async function aiChoiceFrom(input: { ai_provider?: AiChoice["provider"]; ai_address?: string; ai_model?: string }): Promise<AiChoice | "another-server"> {
  const current = await loadAiSettingsView();
  const provider = input.ai_provider ?? current.provider;
  const picked = provider === current.provider ? null : providerOption(provider);
  const baseUrl = picked ? picked.defaultUrl : current.baseUrl;
  if (input.ai_address !== undefined) {
    // An empty address is the provider's usual one.
    const usual = PROVIDER_DEFAULTS[provider].baseUrl;
    const server = serverOf(baseUrl || usual);
    if (!server || serverOf(input.ai_address || usual) !== server) return "another-server";
  }
  return { provider, baseUrl: input.ai_address ?? baseUrl, model: input.ai_model ?? picked?.defaultModel ?? current.model };
}

const choice = settingChoicesSchema.shape;

/** Registers these tools on the connector's server. */
export function registerSettingsTools({ server, linkTo }: ToolContext): void {
  /** A theme saved, copied or imported, which is the base theme now. */
  const themeSaved = (theme: ThemeData, verb: "Saved" | "Made" | "Imported") =>
    text({ message: `${verb} “${theme.name}”. It's now your base resume theme.`, theme: { id: theme.id, name: theme.name, ...lookOf(theme) }, link: linkTo("/resume") });

  server.registerTool(
    "list_themes",
    {
      title: "List the resume themes",
      description: "Every resume theme, built-in and custom, with its look and how many applications use it, and which one is the base theme.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [themes, usage, { baseThemeId }] = await Promise.all([loadThemes(), loadThemeUsage(), loadSettings()]);
      return text({
        base_theme_id: baseThemeId,
        themes: themes.map((theme) => ({ id: theme.id, name: theme.name, built_in: theme.builtIn, applications: usage[theme.id] ?? 0, ...lookOf(theme) })),
        link: linkTo("/resume"),
      });
    },
  );

  server.registerTool(
    "set_base_theme",
    {
      title: "Set the base resume theme",
      description: "Makes a theme from list_themes the base resume theme, which the resume and every document without a theme of its own use.",
      inputSchema: z.object({ id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const theme = await makeBaseTheme(id);
      if (!theme) return failure(THEME_GONE);
      return text({ base_theme: { id: theme.id, name: theme.name }, link: linkTo("/resume") });
    },
  );

  server.registerTool(
    "save_theme",
    {
      title: "Save a resume theme",
      description:
        "Saves a resume theme and makes it the base theme: changes the fields given on a custom theme by id, or makes a new one from based_on (else the base theme). " +
        "based_on alone copies a theme, theme_file imports a theme file's JSON text, and delete: true deletes the custom theme id. Built-in themes never change.",
      inputSchema: z.object({
        id: z.string().min(1).max(100).optional().describe("A custom theme to change or delete; leave out for a new theme"),
        based_on: z.string().min(1).max(100).optional().describe("The theme a new one starts from, built-in or custom"),
        theme_file: z.string().max(20_000).optional().describe("A .dossier-theme.json file's text, imported as a new theme"),
        delete: z.boolean().optional().describe("Deletes the custom theme id; documents that used it use the base theme"),
        ...themeLook,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, based_on, theme_file, delete: remove, ...look }) => {
      const changes = changesFrom(look);
      const changing = Object.keys(changes).length > 0;

      if (remove) {
        if (!id || based_on || theme_file !== undefined || changing) return failure("To delete a theme, give only its id and delete: true.");
        const deleted = await deleteCustomTheme(id);
        if (deleted === "not-found") return failure(THEME_GONE);
        if (deleted === "built-in") return failure("Built-in themes can't be deleted.");
        const base = await loadTheme(deleted.baseThemeId);
        return text({ message: `Deleted “${deleted.name}”.`, base_theme: { id: deleted.baseThemeId, name: base?.name }, link: linkTo("/resume") });
      }

      if (theme_file !== undefined) {
        if (id || based_on || changing) return failure("Import a theme file on its own, then change the new theme by its id.");
        const read = parseThemeFile(parseJson(theme_file));
        if (!read.ok) return failure(read.error);
        return themeSaved(await createTheme(read.theme), "Imported");
      }

      if (id && based_on) return failure("Give id to change a custom theme, or based_on for a new one, not both.");
      if (id) {
        if (!changing) return failure("Say what to change, for example accent or head_font.");
        const current = await loadTheme(id);
        if (!current) return failure(THEME_GONE);
        if (current.builtIn) return failure(BUILT_IN);
        const fields = themeFieldsSchema.safeParse({ ...current, ...changes });
        if (!fields.success) return failure(fields.error.issues[0].message);
        const theme = await updateCustomTheme(id, fields.data);
        if (theme === "not-found") return failure(THEME_GONE);
        if (theme === "built-in") return failure(BUILT_IN);
        return themeSaved(theme, "Saved");
      }

      // A copy as Duplicate makes it, "Modern copy"; with changes, a new theme as the builder starts one, "My theme".
      if (based_on && !changing) {
        const copy = await copyTheme(based_on);
        return copy ? themeSaved(copy, "Made") : failure(THEME_GONE);
      }
      if (!changing) return failure("Say how the new theme looks, for example accent and head_font, or give based_on to copy a theme.");
      const start = await loadTheme(based_on ?? (await loadSettings()).baseThemeId);
      if (!start) return failure(THEME_GONE);
      const fields = themeFieldsSchema.safeParse({ ...start, name: "My theme", ...changes });
      if (!fields.success) return failure(fields.error.issues[0].message);
      return themeSaved(await createTheme(fields.data), "Saved");
    },
  );

  server.registerTool(
    "get_settings",
    {
      title: "Read the settings",
      description:
        "Dossier's settings by Settings' sections: the AI provider and model, the job source, document defaults and languages, backups and task data, Google, and the version. " +
        "Keys are never shown, only whether one is saved.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => text({ ...(await settingsView()), link: linkTo("/settings") }),
  );

  server.registerTool(
    "update_settings",
    {
      title: "Change settings",
      description:
        "Changes the settings given, as Settings saves them, and answers with their sections as get_settings shows them. " +
        "Keys, and moving the AI to another server, stay with the user in Settings. Google and the job agent have update_google_settings and update_job_agent.",
      inputSchema: z.object({
        ai_provider: aiChoiceSchema.shape.provider.optional().describe("Switching starts at its usual server and model, and removes the saved API key; the user enters the new one in Settings"),
        ai_address: aiChoiceSchema.shape.baseUrl.optional().describe("A new path on the same server only"),
        ai_model: aiChoiceSchema.shape.model.optional().describe("One from list_ai_models"),
        creativity: choice.creativity,
        never_invent_experience: choice.strict,
        show_what_changed: choice.showDiff.describe("Mark what the AI changed in a document"),
        job_source: jobSourceChoiceSchema.optional(),
        jsearch_host: jobSearchDetailsSchema.shape.jsearchHost.describe("Where the JSearch key is from"),
        adzuna_app_id: jobSearchDetailsSchema.shape.adzunaAppId,
        paper: choice.paper,
        date_format: choice.dateFormat,
        default_tone: choice.defaultTone,
        document_language: choice.docLanguage.describe("The language documents are written in, added to the list when it's new; null for each posting's own"),
        resume_language: choice.resumeLanguage.describe("The base resume's language, one of Dossier's own, e.g. German"),
        file_name_pattern: choice.fileNamePattern.describe(`PDF file names, from ${FILE_NAME_TOKENS.map(({ token }) => token).join(", ")}`),
        include_references: choice.includeRefs,
        page_limit: choice.pageLimit.describe("The most pages a tailored resume may run to"),
        nightly_backup: choice.nightlyBackup,
        keep_task_data_hours: choice.jobRetentionHours.describe(JOB_RETENTION_OPTIONS.map(({ hours, label }) => `${hours} (${label})`).join(", ")),
        check_for_updates_daily: choice.updateCheck,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const changed = Object.keys(given(input));
      if (changed.length === 0) return failure("Give at least one setting to change. get_settings shows them all.");
      const aiChanged = AI_FIELDS.some((name) => changed.includes(name));

      // What can be refused comes first, and then nothing changes: the AI's server, then the source.
      const ai = aiChanged ? await aiChoiceFrom(input) : null;
      if (ai === "another-server") return failure(ANOTHER_SERVER);
      if (input.job_source) {
        const source = await chooseJobSource(input.job_source);
        if (source === "not-offered") return failure("The Bundesagentur für Arbeit isn't offered on this server.");
        if (source === "not-accepted") {
          return failure("The Bundesagentur für Arbeit is only searched once the user ticks “I understand” under its note in Settings → Job search. Only the user can do that.");
        }
      }
      if (ai) await saveAiChoice(ai);
      if (input.jsearch_host !== undefined || input.adzuna_app_id !== undefined) {
        await saveJobSourceDetails({ jsearchHost: input.jsearch_host, adzunaAppId: input.adzuna_app_id });
      }
      await saveSettings({
        creativity: input.creativity,
        strict: input.never_invent_experience,
        showDiff: input.show_what_changed,
        paper: input.paper,
        dateFormat: input.date_format,
        defaultTone: input.default_tone,
        // As the screen saves it: English as null, which reads the writing direction from the profile.
        resumeLanguage: input.resume_language === "English" ? null : input.resume_language,
        fileNamePattern: input.file_name_pattern,
        includeRefs: input.include_references,
        pageLimit: input.page_limit,
        nightlyBackup: input.nightly_backup,
        jobRetentionHours: input.keep_task_data_hours,
        updateCheck: input.check_for_updates_daily,
      } satisfies SettingChoices);
      // A language goes on the list as "Other language…" adds it; null is each posting's own.
      if (input.document_language === null) await saveSettings({ docLanguage: null });
      else if (input.document_language !== undefined) await pickDocumentLanguage(input.document_language);

      const view = await settingsView();
      const sections = SECTIONS.filter((section) => section.fields.some((name) => changed.includes(name)));
      const aiNotReady = aiChanged && !view.ai.ready;
      return text({
        saved: changed,
        ...Object.fromEntries(sections.map((section) => [section.name, view[section.name]])),
        next: aiNotReady ? "Dossier's own AI isn't ready yet. If the provider needs an API key, the user enters it in Settings → AI provider; test_connection checks it." : undefined,
        link: linkTo(`/settings?section=${sections[0].id}`),
      });
    },
  );

  server.registerTool(
    "list_ai_models",
    {
      title: "List the AI models",
      description: "The models the AI provider in Dossier's settings offers, to choose from with update_settings.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { models, problem } = await availableAiModels();
      if (problem) return failure(problem);
      const ai = await loadAiSettingsView();
      return text({ ai_provider: ai.provider, ai_model: ai.model || null, models, link: linkTo("/settings?section=ai") });
    },
  );

  server.registerTool(
    "test_connection",
    {
      title: "Test a connection",
      description:
        "Tests the AI provider or the job source in Dossier's settings, as their Test connection buttons do: whether it answered and how fast, or what's wrong. " +
        "Testing JSearch or SerpApi uses one search from the user's plan.",
      inputSchema: z.object({ connection: z.enum(["ai_provider", "job_source"]) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ connection }) => {
      if (connection === "ai_provider") {
        const test = await testAiProvider();
        const outcome = test.connected ? { connected: true, model: test.model, seconds: test.seconds } : { connected: false, problem: test.message };
        return text({ connection, ...outcome, link: linkTo("/settings?section=ai") });
      }
      const test = await testJobSourceConnection();
      const outcome = test.connected ? { connected: true, seconds: test.seconds } : { connected: false, problem: test.message };
      return text({ connection, job_source: jobSearchView(await loadJobSearchConfig()).source, ...outcome, link: linkTo("/settings?section=jobs") });
    },
  );

  server.registerTool(
    "zip_all_pdfs",
    {
      title: "Zip all PDFs",
      description:
        "Renders every application's tailored resume and cover letter as PDFs and zips them by company, as Download all PDFs in Settings does. " +
        "Follow it with check_task, which gives the download link once it's done.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const zip = await startPdfZip();
      if (!zip) return failure("There are no tailored documents to download yet.");
      return started(zip.jobId, { documents: zip.documents });
    },
  );

  server.registerTool(
    "export_data",
    {
      title: "Export everything",
      description:
        "Everything in Dossier as one JSON file, as Export in Settings makes it: without API keys, but with contact details and private notes. " +
        "Only when the user asks for an export or backup file; to read data, use get_profile, list_applications and get_application. " +
        `A file up to ${sizeOf(EXPORT_MAX_BYTES)} comes embedded; a bigger one is downloaded with Export in Settings.`,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<CallToolResult> => {
      const now = new Date();
      const data = await buildExport(prisma, { now });
      // The same file Export downloads.
      const json = JSON.stringify(data, null, 2);
      const name = exportFileName(now);
      const bytes = Buffer.byteLength(json);
      const about = { file: name, size: sizeOf(bytes), bytes, applications: data.applications.length, link: linkTo("/settings?section=data") };
      if (bytes > EXPORT_MAX_BYTES) return text({ ...about, next: "It's too big to hand over in a chat. The user downloads it with Export in Settings → Your data." });
      return {
        content: [
          { type: "text", text: JSON.stringify(about, null, 2) },
          { type: "resource", resource: { uri: `dossier://export/${name}`, mimeType: "application/json", text: json } },
        ],
      };
    },
  );

  server.registerTool(
    "check_for_updates",
    {
      title: "Check for updates",
      description: "Asks GitHub for Dossier's latest release, as Check for updates in Settings does, and says whether a newer version is out. Nothing about the user is sent.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const check = await checkForUpdate();
      if (check.status === "unknown") return failure("Couldn't check for updates right now. Try again later.");
      const link = linkTo("/settings?section=about");
      if (check.status === "latest") return text({ status: "latest", version: check.version, message: "You're on the latest version.", link });
      return text({ status: "newer", version: check.version, current_version: appVersion, whats_new: check.url, how_to_update: UPGRADE_GUIDE_URL, link });
    },
  );
}
