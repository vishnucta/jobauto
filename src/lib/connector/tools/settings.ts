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
import { sourceInfo, type JobSearchSettingsView } from "@/lib/job-search/sources";
import { prisma } from "@/lib/prisma";
import { loadProfileSettings, saveProfileSettings } from "@/lib/profiles";
import { UPGRADE_GUIDE_URL } from "@/lib/releases";
import { loadScoringConfig } from "@/lib/scoring/config";
import { SCORER_INFO } from "@/lib/scoring/scorers";
import { ARCHIVE_DAYS, DOCUMENTS_TO_WRITE, DOCUMENTS_TO_WRITE_LABELS, JOB_RETENTION_OPTIONS } from "@/lib/settings";
import {
  aiChoiceSchema,
  availableAiModels,
  loadJobSearchView,
  offeredPortal,
  pickDocumentLanguage,
  portalIdSchema,
  saveAiChoice,
  savePortalFieldValue,
  settingChoicesSchema,
  startPdfZip,
  switchPortal,
  testAiProvider,
  testPortalConnection,
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

import { chooseProfile, failure, profileInput, started, text, type ToolContext } from "../kit";

// Themes, settings without secrets, and exports (jobauto fork): what the
// resume screen's themes and Settings do, through the same functions
// (src/lib/theme-changes.ts, src/lib/settings-changes.ts). Keys stay in
// Settings: no tool takes one or gives one back, and get_settings only says
// whether one is saved. Moving the AI to another server, which its key and
// everything it reads would go to, deleting everything, importing an export,
// the connector itself, adding or updating a portal, and the Bundesagentur
// für Arbeit's "I understand" stay on the screen. The Base resume's theme
// and language are each profile's own (E24-1).

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

/**
 * The portals as Settings → Job search lists them (E22-3): each with its
 * switch and its fields, a key only by its state. A portal from the catalog
 * says whether it's reviewed, and one withdrawn or with an update says so.
 */
function portalsView(view: JobSearchSettingsView) {
  return view.portals.map((portal) => ({
    id: portal.id,
    name: portal.name,
    on: portal.on,
    countries: portal.countries ?? "all",
    fields: Object.fromEntries(portal.fields.map((field) => [field.name, field.type === "secret" ? `key: ${field.keyState}` : field.value])),
    added: portal.installed ? { from: portal.installed.origin, reviewed: portal.installed.reviewed } : undefined,
    note_accepted: portal.consent ? portal.acceptedAt !== null : undefined,
    withdrawn: portal.withdrawal ? { reason: portal.withdrawal.reason, paused: portal.withdrawal.paused } : undefined,
    update: portal.update ? { to: portal.update.to, new_hosts: portal.update.newHosts.length > 0 ? portal.update.newHosts : undefined } : undefined,
  }));
}

/**
 * The settings by Settings' sections, with update_settings' names for what
 * it changes. Keys only by their state: none, set, unreadable (enter it
 * again) or env (from the server's environment). The connected Google
 * account's address stays out like other contact details.
 */
async function settingsView(profileId: string) {
  const [settings, ai, aiReady, jobs, scoring, google, lastBackup, own] = await Promise.all([
    loadSettings(),
    loadAiSettingsView(),
    isAiUsable(),
    loadJobSearchView(),
    loadScoringConfig(),
    googleConnection(),
    lastNightlyBackup(),
    loadProfileSettings(profileId),
  ]);
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
      daily_note_by_ai: settings.dailyNoteAi,
    },
    // Settings → Scoring (E25): what scores postings; its keys stay there.
    scoring: { scorer: SCORER_INFO[scoring.scorer].name },
    job_search: {
      // Every portal, any number switched on (E22-3).
      portals: portalsView(jobs),
      // FreeHire needs no key: where it's searched, its own server or DOSSIER_FREEHIRE_URL.
      freehire_host: jobs.freehire.host,
      archive_after_days: settings.archiveAfterDays,
    },
    documents: {
      paper: settings.paper,
      date_format: settings.dateFormat,
      default_tone: settings.defaultTone,
      document_language: settings.docLanguage,
      // The profile's own Base resume's (E24-1).
      resume_language: own.resumeLanguage ?? "English",
      languages: [...DOCUMENT_LANGUAGES.map((language) => language.name), ...settings.customLanguages],
      file_name_pattern: settings.fileNamePattern,
      include_references: settings.includeRefs,
      documents_to_write: settings.documentsToWrite,
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
  { name: "ai", id: "ai", fields: ["ai_provider", "ai_address", "ai_model", "creativity", "never_invent_experience", "show_what_changed", "daily_note_by_ai"] },
  { name: "job_search", id: "jobs", fields: ["portals", "archive_after_days"] },
  { name: "documents", id: "documents", fields: ["paper", "date_format", "default_tone", "document_language", "resume_language", "file_name_pattern", "include_references", "documents_to_write"] },
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

/** A portal update_settings changes: its switch, and its fields that aren't keys (the JSearch host, the Adzuna app ID, companies' boards). */
const portalChange = z.object({
  id: portalIdSchema.describe("The portal's id from get_settings, e.g. JSEARCH, SERPAPI, ADZUNA, JOOBLE, FREEHIRE"),
  on: z.boolean().optional(),
  fields: z.record(z.string().max(100), z.string().max(5000)).optional().describe("A field's new value by its name from get_settings; '' empties it. Keys stay with the user in Settings."),
});

/** Registers these tools on the connector's server. */
export function registerSettingsTools({ server, linkTo }: ToolContext): void {
  const resumeLink = (profileId: string) => linkTo(`/resume?profile=${profileId}`);
  /** A theme saved, copied or imported, which is the profile's base theme now. */
  const themeSaved = (theme: ThemeData, verb: "Saved" | "Made" | "Imported", profile: { id: string; name: string }) =>
    text({
      message: `${verb} “${theme.name}”. It's now the base resume theme of ${profile.name}.`,
      profile: profile.name,
      theme: { id: theme.id, name: theme.name, ...lookOf(theme) },
      link: resumeLink(profile.id),
    });

  server.registerTool(
    "list_themes",
    {
      title: "List the resume themes",
      description: "Every resume theme, built-in and custom, with its look and how many applications use it, and which one is a profile's base theme.",
      inputSchema: z.object({ profile: profileInput }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ profile }) => {
      const chosen = await chooseProfile(profile);
      if ("failure" in chosen) return chosen.failure;
      const [themes, usage, { baseThemeId }] = await Promise.all([loadThemes(), loadThemeUsage(), loadProfileSettings(chosen.id)]);
      return text({
        profile: chosen.name,
        base_theme_id: baseThemeId,
        themes: themes.map((theme) => ({ id: theme.id, name: theme.name, built_in: theme.builtIn, applications: usage[theme.id] ?? 0, ...lookOf(theme) })),
        link: resumeLink(chosen.id),
      });
    },
  );

  server.registerTool(
    "set_base_theme",
    {
      title: "Set the base resume theme",
      description: "Makes a theme from list_themes a profile's base resume theme, which its Base resume and every document without a theme of its own written from it use.",
      inputSchema: z.object({ id: z.string().min(1).max(100), profile: profileInput }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, profile }) => {
      const chosen = await chooseProfile(profile);
      if ("failure" in chosen) return chosen.failure;
      const theme = await makeBaseTheme(chosen.id, id);
      if (!theme) return failure(THEME_GONE);
      return text({ profile: chosen.name, base_theme: { id: theme.id, name: theme.name }, link: resumeLink(chosen.id) });
    },
  );

  server.registerTool(
    "save_theme",
    {
      title: "Save a resume theme",
      description:
        "Saves a resume theme and makes it a profile's base theme: changes the fields given on a custom theme by id, or makes a new one from based_on (else the base theme). " +
        "based_on alone copies a theme, theme_file imports a theme file's JSON text, and delete: true deletes the custom theme id. Built-in themes never change.",
      inputSchema: z.object({
        profile: profileInput.describe("The profile whose base theme it becomes; the first when left out"),
        id: z.string().min(1).max(100).optional().describe("A custom theme to change or delete; leave out for a new theme"),
        based_on: z.string().min(1).max(100).optional().describe("The theme a new one starts from, built-in or custom"),
        theme_file: z.string().max(20_000).optional().describe("A .dossier-theme.json file's text, imported as a new theme"),
        delete: z.boolean().optional().describe("Deletes the custom theme id; documents that used it use the base theme"),
        ...themeLook,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ profile, id, based_on, theme_file, delete: remove, ...look }) => {
      const changes = changesFrom(look);
      const changing = Object.keys(changes).length > 0;
      const chosen = await chooseProfile(profile);
      if ("failure" in chosen) return chosen.failure;

      if (remove) {
        if (!id || based_on || theme_file !== undefined || changing) return failure("To delete a theme, give only its id and delete: true.");
        const deleted = await deleteCustomTheme(chosen.id, id);
        if (deleted === "not-found") return failure(THEME_GONE);
        if (deleted === "built-in") return failure("Built-in themes can't be deleted.");
        const base = await loadTheme(deleted.baseThemeId);
        return text({ message: `Deleted “${deleted.name}”.`, profile: chosen.name, base_theme: { id: deleted.baseThemeId, name: base?.name }, link: resumeLink(chosen.id) });
      }

      if (theme_file !== undefined) {
        if (id || based_on || changing) return failure("Import a theme file on its own, then change the new theme by its id.");
        const read = parseThemeFile(parseJson(theme_file));
        if (!read.ok) return failure(read.error);
        return themeSaved(await createTheme(chosen.id, read.theme), "Imported", chosen);
      }

      if (id && based_on) return failure("Give id to change a custom theme, or based_on for a new one, not both.");
      if (id) {
        if (!changing) return failure("Say what to change, for example accent or head_font.");
        const current = await loadTheme(id);
        if (!current) return failure(THEME_GONE);
        if (current.builtIn) return failure(BUILT_IN);
        const fields = themeFieldsSchema.safeParse({ ...current, ...changes });
        if (!fields.success) return failure(fields.error.issues[0].message);
        const theme = await updateCustomTheme(chosen.id, id, fields.data);
        if (theme === "not-found") return failure(THEME_GONE);
        if (theme === "built-in") return failure(BUILT_IN);
        return themeSaved(theme, "Saved", chosen);
      }

      // A copy as Duplicate makes it, "Modern copy"; with changes, a new theme as the builder starts one, "My theme".
      if (based_on && !changing) {
        const copy = await copyTheme(chosen.id, based_on);
        return copy ? themeSaved(copy, "Made", chosen) : failure(THEME_GONE);
      }
      if (!changing) return failure("Say how the new theme looks, for example accent and head_font, or give based_on to copy a theme.");
      const start = await loadTheme(based_on ?? (await loadProfileSettings(chosen.id)).baseThemeId);
      if (!start) return failure(THEME_GONE);
      const fields = themeFieldsSchema.safeParse({ ...start, name: "My theme", ...changes });
      if (!fields.success) return failure(fields.error.issues[0].message);
      return themeSaved(await createTheme(chosen.id, fields.data), "Saved", chosen);
    },
  );

  server.registerTool(
    "get_settings",
    {
      title: "Read the settings",
      description:
        "Dossier's settings by Settings' sections: the AI provider and model, the scoring model, the job portals, document defaults and languages, backups and task data, Google, and the version. " +
        "Keys are never shown, only whether one is saved. The base resume's language is a profile's own.",
      inputSchema: z.object({ profile: profileInput.describe("The profile whose base resume language to show; the first when left out") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ profile }) => {
      const chosen = await chooseProfile(profile);
      if ("failure" in chosen) return chosen.failure;
      return text({ ...(await settingsView(chosen.id)), link: linkTo("/settings") });
    },
  );

  server.registerTool(
    "update_settings",
    {
      title: "Change settings",
      description:
        "Changes the settings given, as Settings saves them, and answers with their sections as get_settings shows them. " +
        "Keys, moving the AI to another server, adding a portal and accepting a portal's note stay with the user in Settings. Google and the job agent have update_google_settings and update_job_agent.",
      inputSchema: z.object({
        profile: profileInput.describe("For resume_language: the profile whose base resume it is; the first when left out"),
        ai_provider: aiChoiceSchema.shape.provider.optional().describe("Switching starts at its usual server and model, and removes the saved API key; the user enters the new one in Settings"),
        ai_address: aiChoiceSchema.shape.baseUrl.optional().describe("A new path on the same server only"),
        ai_model: aiChoiceSchema.shape.model.optional().describe("One from list_ai_models"),
        creativity: choice.creativity,
        never_invent_experience: choice.strict,
        show_what_changed: choice.showDiff.describe("Mark what the AI changed in a document"),
        daily_note_by_ai: choice.dailyNoteAi.describe("Have the AI write the dashboard's daily note"),
        portals: z.array(portalChange).min(1).max(30).optional().describe("Switch portals on or off, any number at once, and change their fields that aren't keys"),
        archive_after_days: choice.archiveAfterDays.describe(`Days before a posting left untouched moves to the Archive: ${ARCHIVE_DAYS.join(", ")}`),
        paper: choice.paper,
        date_format: choice.dateFormat,
        default_tone: choice.defaultTone,
        document_language: choice.docLanguage.describe("The language documents are written in, added to the list when it's new; null for each posting's own"),
        resume_language: z.string().trim().min(1).max(60).optional().describe("The profile's base resume's language, one of Dossier's own, e.g. German"),
        file_name_pattern: choice.fileNamePattern.describe(`PDF file names, from ${FILE_NAME_TOKENS.map(({ token }) => token).join(", ")}`),
        include_references: choice.includeRefs,
        documents_to_write: choice.documentsToWrite.describe(
          `What a new application gets written by default: ${DOCUMENTS_TO_WRITE.map((value) => `${value} (${DOCUMENTS_TO_WRITE_LABELS[value]})`).join(", ")}`,
        ),
        nightly_backup: choice.nightlyBackup,
        keep_task_data_hours: choice.jobRetentionHours.describe(JOB_RETENTION_OPTIONS.map(({ hours, label }) => `${hours} (${label})`).join(", ")),
        check_for_updates_daily: choice.updateCheck,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile, ...input }) => {
      const changed = Object.keys(given(input));
      if (changed.length === 0) return failure("Give at least one setting to change. get_settings shows them all.");
      const aiChanged = AI_FIELDS.some((name) => changed.includes(name));
      const chosen = await chooseProfile(profile);
      if ("failure" in chosen) return chosen.failure;
      if (input.resume_language !== undefined && !DOCUMENT_LANGUAGES.some((language) => language.name === input.resume_language)) {
        return failure(`The base resume's language is one of ${DOCUMENT_LANGUAGES.map((language) => language.name).join(", ")}.`);
      }

      // What can be refused comes first, and then nothing changes: the AI's server, then the portals.
      const ai = aiChanged ? await aiChoiceFrom(input) : null;
      if (ai === "another-server") return failure(ANOTHER_SERVER);
      for (const portal of input.portals ?? []) {
        const offered = await offeredPortal(portal.id);
        if ("problem" in offered) return failure(offered.problem);
        // A portal's note, the Bundesagentur für Arbeit's (#223), is the user's to accept, on the screen.
        if (portal.on && offered.setup.config.consent && !offered.setup.acceptedAt) {
          return failure(`${sourceInfo(portal.id).name} is only searched once the user ticks “I understand” under its note in Settings → Job search. Only the user can do that.`);
        }
      }
      for (const portal of input.portals ?? []) {
        if (portal.on !== undefined) {
          const switched = await switchPortal(portal.id, portal.on);
          if ("problem" in switched) return failure(switched.problem);
        }
        for (const [name, value] of Object.entries(portal.fields ?? {})) {
          const saved = await savePortalFieldValue(portal.id, name, value.trim());
          if ("problem" in saved) return failure(`${portal.id} ${name}: ${saved.problem}`);
        }
      }
      const keyRemoved = ai ? (await saveAiChoice(ai)).keyRemoved : false;
      // As the screen saves it: English as null, which reads the writing direction from the profile.
      if (input.resume_language !== undefined) await saveProfileSettings(chosen.id, { resumeLanguage: input.resume_language === "English" ? null : input.resume_language });
      await saveSettings({
        creativity: input.creativity,
        strict: input.never_invent_experience,
        showDiff: input.show_what_changed,
        dailyNoteAi: input.daily_note_by_ai,
        paper: input.paper,
        dateFormat: input.date_format,
        defaultTone: input.default_tone,
        fileNamePattern: input.file_name_pattern,
        includeRefs: input.include_references,
        documentsToWrite: input.documents_to_write,
        nightlyBackup: input.nightly_backup,
        jobRetentionHours: input.keep_task_data_hours,
        updateCheck: input.check_for_updates_daily,
        archiveAfterDays: input.archive_after_days,
      } satisfies SettingChoices);
      // A language goes on the list as "Other language…" adds it; null is each posting's own.
      if (input.document_language === null) await saveSettings({ docLanguage: null });
      else if (input.document_language !== undefined) await pickDocumentLanguage(input.document_language);

      const view = await settingsView(chosen.id);
      const sections = SECTIONS.filter((section) => section.fields.some((name) => changed.includes(name)));
      const aiNotReady = aiChanged && !view.ai.ready;
      return text({
        saved: changed,
        ...Object.fromEntries(sections.map((section) => [section.name, view[section.name]])),
        next: keyRemoved
          ? "The saved API key was removed: a key only goes to the server it was saved for. The user enters one for the new address in Settings → AI provider."
          : aiNotReady
            ? "Dossier's own AI isn't ready yet. If the provider needs an API key, the user enters it in Settings → AI provider; test_connection checks it."
            : undefined,
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
        "Tests the AI provider or a job portal in Dossier's settings, as their Test connection buttons do: whether it answered and how fast, or what's wrong. " +
        "Testing a portal that limits searches, such as JSearch, SerpApi or Jooble, uses one search from the user's plan (Jooble's free plan has 500 in all).",
      inputSchema: z.object({
        connection: z.enum(["ai_provider", "portal"]),
        portal: portalIdSchema.optional().describe("For portal: its id from get_settings, e.g. JSEARCH"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ connection, portal }) => {
      if (connection === "ai_provider") {
        const test = await testAiProvider();
        const outcome = test.connected ? { connected: true, model: test.model, seconds: test.seconds } : { connected: false, problem: test.message };
        return text({ connection, ...outcome, link: linkTo("/settings?section=ai") });
      }
      if (!portal) return failure("Say which portal to test, by its id from get_settings.");
      const listed = (await loadJobSearchView()).portals.find((entry) => entry.id === portal);
      if (!listed) return failure("There's no such portal on this server. get_settings lists them.");
      const test = await testPortalConnection(listed.id);
      const outcome = test.connected ? { connected: true, seconds: test.seconds } : { connected: false, problem: test.message };
      return text({ connection, portal: listed.name, ...outcome, link: linkTo("/settings?section=jobs") });
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
      if (bytes > EXPORT_MAX_BYTES) return text({ ...about, next: "It's too big to hand over in a chat. The user downloads it with Export in Settings → Data and backups." });
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
