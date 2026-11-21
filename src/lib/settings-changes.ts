import "server-only";

import { z } from "zod";

import { AiProvider, Creativity, DateFormat, PaperSize, Tone } from "@/generated/prisma/enums";
import { AiError, createProvider } from "@/lib/ai";
import { keyEnding, keyStateOf, loadAiConfig, loadAiSettingsView, resolveAiConfig, sameServer } from "@/lib/ai/config";
import type { KeyState } from "@/lib/ai/provider-options";
import { DOCUMENT_LANGUAGES } from "@/lib/document-language";
import { env } from "@/lib/env";
import { JobSearchError, testSource } from "@/lib/job-search";
import { credentialsFor, jobSearchView, loadJobSearchConfig, portalSetup, requestContext, savePortals, type PortalSetup } from "@/lib/job-search/config";
import { sourceIdSchema, type JobSource } from "@/lib/job-search/search";
import { sourceInfo, type JobSearchSettingsView } from "@/lib/job-search/sources";
import { startJob } from "@/lib/jobs/runner";
import { countTailoredDocuments, zipPdfsJob } from "@/lib/jobs/zip-pdfs";
import { logServerError } from "@/lib/log";
import { listEntries } from "@/lib/portals/list-field";
import { portalUpdates } from "@/lib/portals/updates";
import { DOCUMENTS_TO_WRITE, isArchiveDays, isJobRetention } from "@/lib/settings";
import { loadSettings, saveSettings } from "@/lib/settings-data";

// What Settings saves and tests (SET-1, SET-2, E10-2, E10-3, E10-5, E22-3),
// for its actions and the Claude connector (#221). Keys are saved in
// Settings only: nothing here takes one, or gives one back.

// ─── AI provider (E6-3) ──────────────────────────────────────────────────────

/** Whether a key is in play for the provider in effect, and where it comes from; never the key. */
export async function aiKeyState(): Promise<KeyState> {
  const saved = await loadSettings();
  return keyStateOf(saved, resolveAiConfig(saved, env));
}

/** The saved key's last four characters (ST4), for the masked field. */
export async function aiKeyEnding(): Promise<string | null> {
  return keyEnding(await loadSettings());
}

/** The provider, server address and model, as Settings → AI provider saves them together. */
export const aiChoiceSchema = z.object({
  provider: z.enum(AiProvider),
  // Saved as typed: the connection test explains a wrong address. A half-typed one on another host removes the key too.
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
});
export type AiChoice = z.output<typeof aiChoiceSchema>;

/**
 * Saves the provider, server address and model (SET-1). A key belongs to
 * its provider and server: another provider, or an address on another host
 * (public PR 107), removes it, so it's never sent to a server it wasn't
 * made for. Another path or model keeps it. Answers with the key's state
 * and ending after, and whether a new address took it.
 */
export async function saveAiChoice({ provider, baseUrl, model }: AiChoice): Promise<{ keyState: KeyState; keyEnding: string | null; keyRemoved: boolean }> {
  const current = await loadSettings();
  const keepsKey = current.provider === provider && sameServer(provider, current.baseUrl, baseUrl);
  await saveSettings({
    provider,
    baseUrl: baseUrl || null,
    model: model || null,
    ...(keepsKey ? {} : { apiKeyEnc: null }),
  });
  return { keyState: await aiKeyState(), keyEnding: await aiKeyEnding(), keyRemoved: current.provider === provider && !keepsKey && current.apiKeyEnc !== null };
}

/** The models the saved server offers, for the model select, or why they can't be listed. */
export async function availableAiModels(): Promise<{ models: string[]; problem: string | null }> {
  try {
    const provider = createProvider(await loadAiConfig());
    return { models: await provider.listModels(AbortSignal.timeout(15_000)), problem: null };
  } catch (error) {
    if (error instanceof AiError) return { models: [], problem: error.message };
    throw error;
  }
}

/** A test connection on a stop-watch has no business waiting minutes. */
export const TEST_TIMEOUT_MS = 60_000;

/**
 * "Test connection" (SET-2): a short prompt to the saved provider, timed.
 * The result is kept (E34-1), with what it tested, for the section and the
 * overview; a change to the provider, address or model makes it old.
 */
export async function testAiProvider(): Promise<{ connected: true; model: string; seconds: number; at: string } | { connected: false; message: string; at: string }> {
  // What it tests, read without the key, so a key that can't be read is a result too.
  const { provider: chosen, baseUrl, model: chosenModel } = await loadAiSettingsView();
  const tested = { at: new Date().toISOString(), provider: chosen, baseUrl, model: chosenModel };
  try {
    const config = await loadAiConfig();
    const provider = createProvider({ ...config, timeoutMs: Math.min(config.timeoutMs, TEST_TIMEOUT_MS) });
    const { model, latencyMs } = await provider.test();
    const seconds = Math.round(latencyMs / 100) / 10;
    await saveSettings({ aiTest: { ...tested, ok: true, seconds, error: null } });
    return { connected: true, model, seconds, at: tested.at };
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    // For the server log: the status and error type, never the provider's message (E6-1).
    logServerError("AI test", new Error(error.detail ?? error.message));
    await saveSettings({ aiTest: { ...tested, ok: false, seconds: null, error: error.message } });
    return { connected: false, message: error.message, at: tested.at };
  }
}

// ─── Job search (E14-4, E22-3) ───────────────────────────────────────────────
// Every portal has its own switch, fields and key. Each answers with what
// Settings → Job search shows, never a key, or with what's wrong in words.

/** What Settings → Job search shows now, with each portal's update from the catalog (E23-5). */
export async function loadJobSearchView(): Promise<JobSearchSettingsView> {
  const config = await loadJobSearchConfig();
  return jobSearchView(config, await portalUpdates(config));
}

/** A portal's id, built in or added (E23-3). */
export const portalIdSchema = sourceIdSchema;

/** A change to a portal: what the section shows after it, or why it wasn't made. */
export type PortalChange = { view: JobSearchSettingsView } | { problem: string };

/** The portal's setup, or why it can't be changed: one this server doesn't offer. */
export async function offeredPortal(id: JobSource): Promise<{ setup: PortalSetup } | { problem: string }> {
  const setup = portalSetup(await loadJobSearchConfig(), id);
  if (!setup?.offered) return { problem: `${sourceInfo(id).name} isn't offered on this server.` };
  return { setup };
}

/**
 * Switches a portal on or off; any number can be on. One with a note (the
 * Bundesagentur für Arbeit's, #223) only goes on with it accepted, now
 * (`accepted`) or before.
 */
export async function switchPortal(portal: JobSource, on: boolean, accepted = false): Promise<PortalChange> {
  const offered = await offeredPortal(portal);
  if ("problem" in offered) return offered;
  if (on && offered.setup.config.consent && !offered.setup.acceptedAt && !accepted) return { problem: "Tick “I understand” under the note first." };
  await savePortals(({ portals, keys }) => {
    const current = portals[portal] ?? { on: false, fields: {}, acceptedAt: null };
    const acceptedAt = accepted ? new Date().toISOString() : current.acceptedAt;
    return { portals: { ...portals, [portal]: { ...current, on, acceptedAt } }, keys };
  });
  return { view: await loadJobSearchView() };
}

/** Saves one of a portal's text, choice or list fields (the Adzuna app ID, the JSearch host, companies' boards), which aren't secrets; empty removes it. */
export async function savePortalFieldValue(portal: JobSource, field: string, typed: string): Promise<PortalChange> {
  const offered = await offeredPortal(portal);
  if ("problem" in offered) return offered;
  const definition = offered.setup.config.fields.find((entry) => entry.name === field);
  if (!definition || (definition.type !== "text" && definition.type !== "choice" && definition.type !== "list")) return { problem: "That field can't be saved here." };
  if (definition.type === "text" && typed.length > 500) return { problem: "That's longer than this field takes." };
  if (definition.type === "choice" && !definition.options.some((option) => option.value === typed)) return { problem: "Choose one of the options." };
  let value = typed;
  if (definition.type === "list") {
    // Kept one a line, as the search reads them; a line that's neither a name nor a link is said, not dropped.
    const { entries, unread } = listEntries(typed, Number.MAX_SAFE_INTEGER);
    if (unread.length > 0) return { problem: `${unread.length === 1 ? `“${unread[0]}” isn't` : `${unread.length} lines aren't`} a name or a link Dossier can read.` };
    if (entries.length > definition.max) return { problem: `${definition.label} takes up to ${definition.max}.` };
    value = entries.join("\n");
  }
  await savePortals(({ portals, keys }) => {
    const current = portals[portal] ?? { on: false, fields: {}, acceptedAt: null };
    const fields = { ...current.fields };
    if (value) fields[field] = value;
    else delete fields[field];
    return { portals: { ...portals, [portal]: { ...current, fields } }, keys };
  });
  return { view: await loadJobSearchView() };
}

/** "Test connection": the smallest request a portal takes, timed. */
export async function testPortalConnection(portal: JobSource): Promise<{ connected: true; seconds: number } | { connected: false; message: string }> {
  const config = await loadJobSearchConfig();
  const started = performance.now();
  try {
    await testSource(portal, credentialsFor(config, portal), requestContext(portal));
    return { connected: true, seconds: Math.round((performance.now() - started) / 100) / 10 };
  } catch (error) {
    if (error instanceof JobSearchError) return { connected: false, message: error.message };
    throw error;
  }
}

// ─── Choices and switches (E10-2, E10-3) ─────────────────────────────────────

/** The settings that are a plain choice or switch, each saved as it changes; only the fields given are touched. */
export const settingChoicesSchema = z.strictObject({
  creativity: z.enum(Creativity).optional(),
  strict: z.boolean().optional(),
  showDiff: z.boolean().optional(),
  /** The dashboard's daily note by the AI (E28-6). */
  dailyNoteAi: z.boolean().optional(),
  paper: z.enum(PaperSize).optional(),
  dateFormat: z.enum(DateFormat).optional(),
  defaultTone: z.enum(Tone).optional(),
  /** A language name, or null for the posting's language. */
  docLanguage: z.string().trim().min(1).max(60).nullable().optional(),
  fileNamePattern: z.string().max(200).optional(),
  includeRefs: z.boolean().optional(),
  germanOnlyWhenFit: z.boolean().optional(),
  documentsToWrite: z.enum(DOCUMENTS_TO_WRITE).optional(),
  nightlyBackup: z.boolean().optional(),
  jobRetentionHours: z.number().refine(isJobRetention).optional(),
  updateCheck: z.boolean().optional(),
  /** Days before an untouched posting moves to the Archive (E22-7). */
  archiveAfterDays: z.number().refine(isArchiveDays).optional(),
  alertMinScore: z.number().int().min(0).max(100).optional(),
  weeklyTarget: z.number().int().min(0).max(50).optional(),
  supporterDay: z.number().int().min(1).max(7).optional(),
  supporterHour: z.number().int().min(0).max(23).optional(),
});
export type SettingChoices = z.output<typeof settingChoicesSchema>;

/**
 * "Other language…" (SET-7): adds a language to the list and writes
 * documents in it. A name already in the list, in any case, is just picked.
 */
export async function pickDocumentLanguage(name: string): Promise<{ language: string; added: boolean }> {
  const { customLanguages } = await loadSettings();
  const known = [...DOCUMENT_LANGUAGES.map((language) => language.name), ...customLanguages];
  const existing = known.find((language) => language.toLocaleLowerCase() === name.toLocaleLowerCase());
  await saveSettings({ docLanguage: existing ?? name, ...(existing ? {} : { customLanguages: [...customLanguages, name] }) });
  return { language: existing ?? name, added: !existing };
}

// ─── Data and backups (E10-5) ────────────────────────────────────────────────

/** "Download all PDFs": zips every tailored document in the background; null when there are none yet. */
export async function startPdfZip(): Promise<{ jobId: string; documents: number } | null> {
  const documents = await countTailoredDocuments();
  if (documents === 0) return null;
  return { jobId: await startJob(zipPdfsJob, {}), documents };
}
